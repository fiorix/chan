# chan-workspace design

Canonical design reference for `chan-workspace`. Update in the same commit as any change that affects state placement, the exported interface shape, the locking model, or the schema versions.

## 1. Problem and scope

`chan-workspace` is the local-first filesystem, search, graph, and workspace-state core for chan. It owns the per-machine registry of known workspaces and the per-workspace search index, link graph, and code/SLOC report. Its `Workspace` facade provides sandboxed filesystem access rooted at a registered directory; its metadata-free `MiniWorkspace` facade provides the standalone Files surface without a registry row, writer lock, index, or graph. Both share the same crate-private filesystem-capability core. `DraftStore` sits beside them as the per-library drafts lifecycle for standalone windows (see "Drafts"). The crate backs the `chan` CLI, chan-server, and the desktop app, and its API is shaped to survive a uniffi boundary for native iOS / Android shells.

In scope:

  - Filesystem primitives (`read` / `write` / `stat` / `list` / `rename` / `copy` / `remove` / `list_tree`) rooted at a workspace, including bounded byte streams and progressively limited atomic writes.
  - Workspace registry persisted to `~/.chan/config.toml` (or the OS sandbox equivalent on iOS / Android).
  - Per-workspace search index (tantivy 0.24, BM25; optional dense via candle + BGE-small for hybrid).
  - Per-workspace graph database (sqlite, single writer, r2d2 pool for readers).
  - Per-workspace code/SLOC report (chan-report `Index` kept current by the watcher, persisted as JSONL).
  - Filesystem watcher (callback-based, workspace-scoped, drops `.chan/` and walk-filtered noise) plus a built-in debounced graph indexer on top of it.
  - Cross-process advisory writer lock (fs4 / flock / LockFileEx).
  - Path-traversal sandboxing and an editable-text gate (extension classifier plus content sniff).
  - Atomic writes for every chan-workspace-managed file.
  - Cmd+N drafts as ordinary in-tree files under a configurable in-root directory.
  - Per-workspace blob storage for opaque host JSON: pane sessions. chan-workspace stores bytes keyed by a flat identifier; the schema is the host's choice.
  - Stat-only bootstrap snapshot of the tree shape for UIs that render before any index exists.
  - Export / import of the per-workspace sidecar metadata as a zstd-compressed tar archive.
  - VCS-parent detection (pure stat-walk; no `git` invocation).

Out of scope:

  - HTTP, WebSocket, frontend bundle. Those live in `chan-server` and the `chan` binary.
  - LLM tool dispatch, API key storage, prompt content, and agent transcript storage. `chan-llm` and app-level concerns.
  - Editor preferences (fonts, theme, keybindings, attachments dir). App-level; the consumer owns its own config file.
  - User authentication, multi-user collaboration, cloud sync of chan-workspace state. Single-user, single-machine, local-first.
  - Cross-workspace linking. One workspace at a time; explicit non-goal.

## 2. Architecture overview

```mermaid
flowchart TB
  Lib["Library: registry and sidecars under one chan home"] --> WS["Workspace (writer-locked handle)"]
  subgraph Subsystems
    FS["Filesystem -- cap-std, CAS, trash, drafts"]
    Search["Search -- tantivy BM25 (+ optional candle embeddings)"]
    Graph["Graph -- sqlite: links, tags, mentions, headings"]
    Watch["Watch -- notify -> debounced incremental index"]
  end
  WS --> FS
  WS --> Search
  WS --> Graph
  WS --> Watch
  Watch -. re-index .-> Search
  Watch -. re-index .-> Graph
  WS --> Report["report() -> chan-report"]
```

  - `Library` is a per-machine handle. Apps construct one at startup and keep it alive. It owns the registry and the config-file path.
  - `Workspace` is one registered directory. Holds the writer lock for its lifetime; cheap reads (search query, graph traversal) do not contend. Its filesystem face is a crate-private `RootedFs` core: the display root, its canonical form and unix identity, the cap-std `Dir` handle every user-path operation routes through, and the transfer ceiling that bounds opaque-byte writes. Search and graph sidecars are metadata-opened during construction; `OnceLock` retries on first use only when that probe failed. Report state stays lazy.
  - `WatchHandle` owns a supervised watcher lifecycle. `health()` exposes starting, healthy, degraded, and stopped state with failure and retry counters; partial registration returns a degraded handle that retries; `stop()`, `join()`, and drop all synchronously reclaim the watcher thread and descriptors.
  - `GraphIndexer` is the built-in consumer of the watcher: a worker thread that debounces per-path events into `index_file` / `forget_file` / `reconcile` calls.

## 3. Components

### Library

Per-machine singleton-in-practice. Owns the `Registry` (`Mutex<Registry>` intra-process), the config-file path, the co-located chan home for workspace sidecars, and the directory-name blocklist for indexing walks. `Library::open_at(config_path)` captures `config_path.parent()` as that home, so an explicitly located registry never places sidecars through ambient `CHAN_HOME`; `Library::open()` keeps the default registry and sidecars together under `paths::config_dir()`. `open_workspace` looks up the registry row for the caller's path and constructs a `Workspace` keyed by the row's `metadata_key`, holding the cross-process writer lock for its lifetime.

Each registry row carries the canonical `root_path`, a stable `metadata_key`, an optional `display_name`, and timestamps. The key is derived from the first registered path as a readable path slug plus an 8-hex sha256 suffix, and is preserved across `Library::move_workspace`. All per-workspace sidecar state (graph DB, search index, sessions, tokens, trash, report) is keyed by that metadata key. `Workspace::canonical_root`, `metadata_key`, and `display_name` expose read-only identity; the effective display name falls back to the root basename. Consequences:

  - Moving the workspace directory (recorded via `move_workspace`) is a registry-only change, zero file motion on the sidecars.
  - Registering the same canonical path is idempotent and preserves the metadata key.
  - Deleting then re-creating a workspace at the same path uses the same deterministic key. `unregister_workspace` wipes chan-managed state so stale sidecars do not reappear by accident.
  - A user-managed display name is presentation metadata only; routing and sidecar placement continue to use canonical roots and metadata keys.

The registry also holds two global, hand-edited policy fields: `index_excluded_dirs` (directory basenames the indexing walks skip; see "Walk filter") and `drafts_dir` (the in-root drafts directory name, default `.Drafts`; see "Drafts").

`Library::sweep_orphans` reconciles the on-disk sidecar namespace against the registry: any entry whose key is not in the current metadata-key set is reclaimed. Used to clean up after unregisters that left state behind, or after a `move_workspace`-then-deleted-at-new-location workflow.

`reset_workspace` wipes per-workspace chan-managed state (search index, graph DB, session blobs, app tokens, persisted report). It never touches the user's notes tree. The trash is preserved (it holds user-deleted files, recoverable user data, not chan-managed cache). The lock dir is preserved (cross-process coordination, no data). `ResetMode::Everything` additionally drops the registry entry so the next `open_workspace` against the path treats it as a fresh, never-seen workspace.

Precondition: caller must drop any open `Arc<Workspace>` for the target root first. `reset_workspace` acquires the writer lock to verify exclusive access; if the caller still holds a handle the call fails with `WorkspaceAlreadyOpen`, and a foreign-process holder fails with `WorkspaceLocked`. On Unix this is defense-in-depth (open files survive unlink); on Windows it is load-bearing because removing files-in-use fails. Skeleton recreation happens lazily on the next `open_workspace` plus first `index()` / `graph()` access; no explicit init step.

Registration is idempotent: re-registering an existing workspace only updates `last_seen_at` and preserves the metadata key.

`unregister_workspace` is `reset_workspace(Everything)` plus a `false` return when the workspace wasn't in the registry. It drops the registry row AND wipes per-workspace state in one call so a re-register at the same path starts from a clean sidecar even when the row's metadata key is deterministic. The trash is preserved (recoverable user data, owned by the user even after the workspace is forgotten). Preconditions match `reset_workspace`: any open `Arc<Workspace>` for the root must be dropped first, otherwise the call fails with `WorkspaceAlreadyOpen`.

`move_workspace(old, new)` records a moved workspace directory: it rewrites the registry row's `root_path` while preserving the metadata key, so every sidecar follows the move with zero file motion. Refuses when the source is unregistered, when `new` doesn't exist, when `new` is already a different workspace, or when the source is open.

### Workspace

One registered directory. All `rel` arguments are POSIX-style relative paths. Path traversal (`..`, absolute roots, Windows workspace prefixes) is rejected via `fs_ops::resolve_safe`, then `fs_ops::resolve_safe_strict` adds a canonical-form check that the deepest existing ancestor stays under the canonical workspace root (catches mid-path symlinks escaping the sandbox).

The filesystem core is a crate-private `RootedFs` value held by `Workspace`: the display root, its canonical form and unix `(dev, ino)` identity, the cap-std `Dir` handle, and the transfer ceiling for opaque-byte writes. Every user-path primitive (`classify_workspace_path`, `ensure_writable`, `write_atomic_stream`, the read/write/stat/list family, `rename`, `copy`, `resolve_free_name`, physical-path resolution, and `ensure_root_available`) executes inside `RootedFs`; the `Workspace` methods delegate to it and layer the metadata-coupled operations (trash-backed `remove`, link-rewriting rename, drafts, sessions, index and graph maintenance) on top.

The same core backs the public, metadata-free `MiniWorkspace`: one capability root plus a protected canonical start directory, opened without registry rows, workspace locks, sidecar metadata, indexing, or a graph. It speaks a stricter wire dialect (UTF-8, POSIX-relative, absolute paths refused rather than re-rooted, `""` only for root queries), shows every ordinary entry including dotfiles and control dirs while skipping non-UTF-8 names, keeps symlinks inert (visible in listings, refused by every read, write, copy, move, and delete), deletes only regular files and empty directories (`DirectoryNotEmpty` / `ProtectedPath` are typed refusals), and moves and copies without link rewriting: no clobbering, whole-tree preflight, cross-device moves through a uniquely named temporary sibling with the source removed only after the destination is complete. A write through a `MiniWorkspace` is an external write to any real `Workspace` covering the same physical file.

Two gates guard the text-class APIs:

  - **Editor gate** (`fs_ops::is_editable_text` plus `Workspace::sniff_is_text`): a file the editor can round-trip through a UTF-8 buffer. The extension classifier accepts markdown-class `.md` / `.txt` plus the wider `FileClass::Text` set (source code, configs, shell scripts, well-known no-extension files). Paths the classifier refuses get a content-sniff fallback: read up to `fs_ops::TEXT_SNIFF_BYTES` (8 KiB) and apply `fs_ops::looks_like_text`, which is what lets the editor open `.zshrc`, `*.service`, `Kconfig`, and other extensionless or odd-suffix text files. A file that cannot be sampled (I/O error, non-regular) stays non-editable. The classifier stays a pure, I/O-free path predicate so hot index walks never pay the sniff; only the per-file read/write path does. Used by `read_text` / `read_text_with_stat` / `read_text_with_stat_chunked` / `write_text` / `write_text_if_unchanged`.
  - **Indexer gate** (`fs_ops::is_indexable_text`): true only for `FileClass::EditableText` (markdown-class `.md` / `.txt`). Used by the indexer, graph rebuild, link-rewrite on rename, and reindex-after-restore. A `.py` is editable but **not** indexable so `#include` doesn't read as a `#tag`. Within the indexable set, `fs_ops::is_markdown_file` narrows `#tag` / `@@mention` token extraction to `.md` only: `.txt` indexes for full-text, headings, and links, but incidental prose in a plain note never becomes a graph tag.

Binary I/O (`read` / `write_bytes`) routes around both gates: attachments and the future media browser still need it.

`Workspace::write_atomic_stream` is the canonical progressive write path. The caller feeds chunks through `AtomicWriteSink`; the sink writes directly into a same-directory cap-tempfile, rejects a chunk before writing when it would exceed the effective budget, validates text incrementally without rejecting a UTF-8 code point split across chunks, and exposes no commit operation. The workspace commits only after the feed returns successfully and the UTF-8 validator has no incomplete tail. Every earlier error, cancellation, or panic drops the temp and leaves the target untouched. `write_text`, `write_text_if_unchanged`, and `write_bytes` delegate to this primitive.

`Workspace::ensure_writable` is the single strict write preflight. It validates through the cap-std sandbox, rejects directory, symlink, special, and read-only targets, probes same-directory temp creation, and returns `WritableFile { stat }`, where `stat` is the existing regular file's `FileStat` for mtime-token and budget decisions or `None` for a create. `Workspace::classify_workspace_path` uses the same sandbox and returns missing, regular, directory, or special as values while lexical and symlink escapes remain typed errors.

`Workspace::read_bytes_bounded` opens and fstats one regular file and returns `BoundedFileReader`, a same-thread iterator that reads 64 KiB chunks from the open handle on the consumer's own thread. The byte window is frozen from the open-handle stat: growth after open is excluded from the stream, and a mid-stream shrink is an error rather than a short success. `BoundedFileReader` never allocates a whole-file buffer; dropping it closes the handle.

#### Supported file types

A workspace is the user's directory tree, untouched. Adding a workspace registers a root and walks everything under it (skipping `.git/` and `.chan/`); chan-workspace never restricts what can sit on disk. What changes by class is how each file is handled by the API. `fs_ops::classify(rel)` is the single predicate; consumers (this crate, chan-server, the editor) should switch on `FileClass` rather than re-deriving extension rules.

  Class           Extensions / names
  --------------  ----------------------------------------------
  EditableText    .md, .txt
  Text            .py, .rs, .c, .cpp, .h, .go, .java, .js, .ts, .json, .yaml, .toml, .ini, .sh, .html, .css, .csv, .sql, .rst, ...; plus well-known basenames (Makefile, Dockerfile, LICENSE, .gitignore, ...)
  Image           .png, .jpg, .jpeg, .gif, .webp, .svg, .avif
  Pdf             .pdf
  Other           everything else

Behaviour by class:

  - **EditableText**: full read / write through `read_text` and `write_text`. Indexed by tantivy (BM25 + dense vectors when embeddings are enabled). Parsed for graph edges, headings, tags, mentions. The CAS pair `read_text_with_stat` + `write_text_if_unchanged` is available for editor-style optimistic concurrency. Large editor opens can use `read_text_with_stat_chunked` to receive the same open-handle stat before the UTF-8 body chunks.
  - **Text**: full read / write through `read_text` and `write_text` (same UTF-8 gate as EditableText). **Not** indexed and **not** a graph node: the indexer parses markdown semantics that source-class text doesn't carry, and treating `#include` as a `#tag` would pollute the graph. Text-class files are walkable + editable + byte-readable but opaque to search.
  - **Image**: opaque bytes via `read` / `write_bytes`. Not indexed and not a graph node, but markdown embeds (`![alt](img.png)`) emit edges pointing at the image so `backlinks("media/foo.png")` returns the notes that embed it. The editor renders previews inline; rename / remove are supported.
  - **Pdf**: same I/O contract as Image. Held as a distinct class because the editor / inspector pane renders PDFs through a dedicated viewer.
  - **Other**: opaque bytes via `read` / `write_bytes`. Walkable, visible in `list_tree`, renameable, removeable into Trash. Unknown-extension files whose leading bytes sniff as text additionally pass the editor gate (see above). Not indexed and not a graph node.

`rename`, `copy`, and `remove` operate on every class. Link rewriting in `rename_with_link_rewrite` only touches `EditableText` bodies (Text-class files, images, and other binaries have no markdown links to rewrite); the graph edge `dst` gets updated regardless of target class. `resolve_free_name` computes a collision-free destination name for copy / promote flows.

Typed markdown frontmatter is resolved through a nested `chan.kind` registry. The only supported entry today is `contact`, which stamps a graph node as `Contact` and gives server/web callers the `contact` renderer hint; unknown kinds stay ordinary markdown files. Semantic reference tokens are markdown-only: `#tag` and `@@mention` graph edges are extracted from `.md` files and intentionally ignored in `.txt`, so plain notes remain searchable/editable without turning incidental prose into graph entities.

Extension matching is ASCII case-insensitive. Files whose extension is unknown fall back to a basename check against well-known textual filenames (Makefile, Dockerfile, LICENSE, ...), then to the content sniff on the read/write path.

`read_text_with_stat` and `write_text_if_unchanged` are the optimistic-concurrency pair the editor uses to detect external edits. The editor reads `(content, stat)`, the user types, and the save round-trips through `write_text_if_unchanged(rel, Some(stat.mtime_ns), expected_disk, new_content)`. The token is the nanosecond mtime so two edits within the same wall-clock second still conflict on filesystems with sub-second mtime. Because a filesystem timestamp does not advance on every write, a matching mtime is additionally verified against the last-observed disk bytes when the caller passes `expected_disk`; callers holding no such belief pass `None` and get the mtime test alone. If another process (terminal, sync daemon, second pane) has since modified the file, the write fails with `WriteConflict { current_mtime_ns }` and the editor prompts to reload, merge, or overwrite. `write_text` (no CAS) remains for chan-workspace's own reindex helpers, bulk imports, and LLM-tool calls where last-write-wins is the intent. Residual race: between the mtime check and the atomic rename a foreign write can land; the watcher event for the foreign change fires on the next dispatch and the editor re-prompts.

`read_text_with_stat_chunked` is the streaming form for large editor opens. It applies the same editable-text gate, sandbox resolution, regular-file refusal, symlink refusal, and open-handle stat semantics as `read_text_with_stat`. Events are ordered as `Meta(&FileStat)`, zero or more UTF-8 `Chunk(&str)` events, then `Done`. UTF-8 code points are never split across chunk events; an invalid byte sequence fails the read. If the callback returns false, the read stops early with `Ok(())` so transports can stop work after client disconnect.

`remove` is a soft-delete: it moves the entry into the per-workspace Trash. Recursive directory removal is allowed because the operation is reversible; the foot-gun guard against accidental recursive-rm is satisfied by the restore path. Symlinks, FIFOs, sockets, and char/block devices are rejected with `SpecialFile`; the trash format only models regular files and directories, and chan-workspace never creates the other types itself.

### Drafts

Cmd+N scratch work lives in-tree as a real hidden directory at the workspace root, named by `Registry::drafts_dir` (default `.Drafts`). Each draft is a small directory with a main markdown document plus companions such as pasted images, so attachments travel with the note. The directory is created lazily on the first Cmd+N; an untouched workspace has no `.Drafts/`.

Drafts are ordinary relpaths, so search, graph, watcher, and the MCP tools see them through the normal machinery: no virtual namespace, no separate cap-std handle, no separate watch root, and no synthesized graph node. Users who do not want drafts tracked by SCM add `.Drafts/` to their `.gitignore`. `.Drafts` is deliberately NOT on the walk filter: drafts are real in-tree content and index and graph like any other file.

The `drafts` module is the filesystem primitive layer; `Workspace` wraps it as `create_draft_dir`, `list_drafts`, `inspect_draft`, `promote_draft`, `discard_draft`, `draft_preflight`, and `next_untitled_draft_name`. Promotion moves the draft's contents to a destination in the main tree and reports the mode (`File` for a lone `draft.md`, `DirectoryCreated` / `DirectoryMerged` when companions exist). Discard routes through the Trash, with the trash entry's origin label prefixed `.Drafts` so a trashed draft is distinguishable from a trashed workspace file. `draft_preflight` reports broken drafts (e.g. a draft dir missing its `draft.md`) without failing the listing.

`DraftStore` is the second wrapper over the same primitives, for windows with no workspace behind them: drafts for the standalone Files surface live under an embedder-injected state root as `<root>/Drafts/<name>/...`, with discards in a dedicated flat `<root>/drafts-trash/` (entries directly under it, the shape every `trash::*` consumer handles; labels are `Drafts/<name>` so restore resolves against the store root). The embedder injects the root because only it knows the host identity (the desktop's chan home vs a devserver's `devserver/` state dir), the same way the terminal session store is injected. The store owns lifecycle only; draft content is served as ordinary wire paths over the standalone capability root, and promotion targets are resolved by `MiniWorkspace::resolve_write_target` (wire dialect, per-component symlink refusal), never by the store, so target-resolution guards live in exactly one place per facade. An internal mutex serializes the mutating operations: the store has no writer lock, and two windows on one shared tenant are the common case.

### Trash

The Trash gives the editor and the LLM tool sandbox a safe delete: every `remove` is reversible until either the user explicitly purges or the retention window elapses.

Trash entries expose five stable fields: opaque monotone `id`, workspace-relative POSIX `original_path`, Unix-seconds `deleted_at`, `is_dir`, and `size` (file length or recursive directory total).

  - **Location**: Trash lives in the per-workspace sidecar, outside the user's workspace directory, because chan-workspace stores zero state inside the workspace (the drafts dir is the one deliberate exception). Each entry has an opaque id, the moved payload, and metadata written last. Trade-off: the trash does not sync via iCloud / Dropbox / git. Acceptable; trash is per-machine recovery, not collaboration. A recorded `Library::move_workspace` preserves `metadata_key`, so trash follows the moved workspace without moving files.
  - **Atomicity**: same-fs path is one atomic `rename` from workspace root into the trash payload. Cross-fs path falls back to `copy + remove`, writing the metadata AFTER the copy and BEFORE the source removal, so a remove failure leaves a complete trash entry plus a partial source the user can clean up.
  - **Restore conflicts**: refused with `TrashOccupied`. The caller renames the live entry first, or `trash_purge` to give up. We never silently overwrite live content.
  - **Auto-expiration**: lazy GC. Workspace open and every `trash_*` call sweep entries older than `TRASH_RETENTION_SECS` (30 days, `30 * 24 * 60 * 60`). No background thread; matches the codebase's sync-only rule.
  - **Crash recovery**: a half-written entry has no metadata. Sweep treats metadata-less entries as junk and reclaims them.
  - **Flat root, entries only**: a trash root contains only entry dirs. Never nest another store (or any non-entry file) inside a swept root; the sweep reads such a child as one meta-less junk entry and reclaims it wholesale. Draft discards are therefore first-class flat entries distinguished by their `.Drafts/<name>` origin label, and workspace open hoists any entries still sitting in the nested `drafts/` bucket an older release wrote before its sweep runs.

Deliberately not included:

  - Cross-workspace trash. Each workspace has its own.
  - Sync to cloud storage (trash is local-only state).
  - Background timer (lazy GC is enough for an editor that opens workspaces sporadically).
  - Configurable retention. Hardcoded 30 days.

### Search index

`tantivy` 0.24 backs the per-workspace index in sidecar state. BM25 runs over `heading` and `body`; the schema also stores `path` and `chunk_id` as exact-match fields for delete-by-path and hit attribution. Schema version lives in the `schema_version` field of the `IndexConfig` struct (alongside the embedding model id and the chunking strategy). Mismatched versions trigger a wipe and full rebuild on next open; user data is unaffected.

The index config also persists `excluded_dirs`, the per-workspace additions to the walk filter. Presentation and feature toggles live separately in `dashboard.toml`: `semantic_enabled` (hybrid-search opt-in, default false), `reports_enabled` (chan-report opt-in, default true), and the screensaver settings (`screensaver_enabled`, timeout, theme, and a base64-encoded PIN hash that is stored without interpretation and never echoed back over the wire). `Workspace` exposes typed accessors for these settings; dashboard writes serialize through one mutex and use the same atomic-write primitive as the index config.

Two additional config fields, `vectors_model` and `vectors_dim`, describe the model that produced the vectors currently on disk. They are stamped at the end of every successful embed pass. On `Index::open`, if `vectors_model` is set and differs from `model` (the user-configured target), the embeddings dir is wiped and the tracking fields cleared; BM25 segments are preserved because BM25 is model-independent. This closes the silent-corruption window where a hand-edited or upgraded `model` field would otherwise mix vectors from two different models in the same store. A schema-version bump still wipes everything and clears both tracking fields.

With the `embeddings` feature on (default), the index also stores per-chunk dense vectors via candle + BGE-small (`DEFAULT_MODEL = "BAAI/bge-small-en-v1.5"`). `SearchMode` is `Bm25` (default), `Semantic`, or `Hybrid`; hybrid runs BM25 and dense in parallel, then fuses with reciprocal-rank fusion. Dense search is a per-workspace opt-in (`semantic_enabled`); on builds where the embedder is unavailable (`--no-default-features`, currently iOS) or the model is not downloaded, semantic and hybrid queries degrade to BM25-only and the result's `mode` field says so.

Chunking is configurable per-index via `Chunking` (`Headings`, `WholeDoc`, `Fixed { chars }`). The default is `Headings` (one chunk per ATX section, files without headings collapse to a single whole-doc chunk).

`reindex` is synchronous and blocking. It runs on the calling thread; the caller decides whether to spawn a worker. `reindex_with` accepts a progress callback driven by `ProgressStage` events; `reindex_with_aggression` additionally takes a `SearchAggression`. All flavors return `BuildSummary`. This keeps the API uniffi-clean and avoids leaking an async runtime through the FFI boundary.

`Index::build_all` runs the per-file read + markdown chunking on a bounded thread pool. Worker count comes from `SearchAggression`: `Conservative` pins one reader, `Balanced` (the default) uses `available_parallelism - 2` clamped to [1, 6], `Aggressive` uses `available_parallelism - 1` clamped to [1, 8]. The file-descriptor budget (`fd_budget`) can cap the count further and paces workers when the process is near its `nofile` limit: the crate runs inside the editor process, where macOS commonly starts with a soft limit of 256, and an eager SQLite pool plus Tantivy fanout can otherwise exhaust the table during first boot on a large workspace. Workers ship parsed chunks to the main thread over a bounded `sync_channel` (workers * 2 / 4 / 8 for Conservative / Balanced / Aggressive); the main thread is the only writer into tantivy and the only producer of embed batches, so writer-mutex contention and embed ordering stay simple. Cores are held back so the server's tokio runtime and the OS UI thread keep breathing during a reindex of a large workspace. Progress ticks remain monotonic from the consumer's perspective even when worker completions land out of order.

#### Unified workspace search

`Workspace::workspace_search` is the workspace-local retrieval contract used by transports. One owned, serde-compatible request combines optional content retrieval, lexical file/directory/tag/mention/contact/language matching, exact typed selectors, and bounded traversal. Normalization applies defaults, stable deduplication, and hard caps once in this crate. Request, selector, readiness, ambiguity, and unavailable-domain failures remain structured result entries so valid seeds can still return partial work; SQLite, Tantivy, and filesystem failures use the outer `Result`.

The query path performs one filtered metadata-only tree walk. It may read maintained graph rows, the ready search index, and a warm or valid persisted report snapshot, but it never reads source bodies, mutates registry/config state, starts a report scan, or initiates an index rebuild. `effective_search_mode` is the single BM25/hybrid policy: hybrid is effective only when semantic search is enabled and the configured model resolves; no-embeddings builds always report BM25.

Traversal is breadth-first and queries semantic graph edges in SQLite bind-bounded frontier batches. File and contact nodes reserve their complete root containment spine before admission. Node and relationship limits can therefore omit a candidate, but never return it parentless; forced spine relationships are recorded in the effective traversal. Containment and maintained-report language relationships are joined in memory, and tag/mention/contact/directory profiles receive bounded metadata closure without traversing through closure nodes. A final batched incident-edge pass retains the relationship-induced subgraph among admitted nodes, matching the visualization lenses without per-node queries. Returned nodes and relationships have stable hop/kind/ID ordering.

```mermaid
flowchart TB
  Files["list_indexable -> files[]"]
  Budget["aggression.budget(): worker_count, queue_bound, embed_batch_chunks"]
  Fd["fd_budget: cap_index_read_workers + pace_reindex_worker"]
  Ch["bounded sync_channel(queue_bound)"]
  subgraph Pool["bounded read + chunk worker pool"]
    W1["worker: read_to_string + chunking::chunk"]
    W2["worker: read_to_string + chunking::chunk"]
  end
  Drain["main thread: drain rx (only writer)"]
  Bm25["bm25.index_chunks(rel, chunks)"]
  Skip{"on-disk shard (model, body_hash) matches?"}
  Pend["accumulate pending chunks"]
  Flush{"pending_chunks >= embed_batch_chunks?"}
  Commit["bm25.commit() then flush_embed_batch (embed forward pass)"]
  Shards["per-file vector shards"]
  Final["tail flush, orphan cleanup, final bm25.commit, stamp vectors_model -> BuildSummary"]

  Budget --> Fd
  Fd -->|"caps worker_count"| Pool
  Files -->|"file indices via AtomicUsize next"| Pool
  W1 --> Ch
  W2 --> Ch
  Ch -->|"WorkerOut"| Drain
  Drain --> Bm25
  Bm25 -->|"if do_vectors"| Skip
  Skip -->|"match: embeds_reused++"| Drain
  Skip -->|"no match"| Pend
  Pend --> Flush
  Flush -->|"below threshold"| Drain
  Flush -->|"threshold reached"| Commit
  Commit --> Shards
  Drain -->|"channel drained"| Final
  Final -.->|"tail flush"| Shards
```

*build_all fans file reads across an fd-budget-capped, SearchAggression-sized worker pool, funnels parsed chunks through a bounded sync_channel to the single main-thread writer that commits BM25 per flush and runs embed passes in embed_batch_chunks-sized flushes into per-file vector shards.*

#### Embed-phase checkpointing

Embedding dominates the wall-clock cost of a full rebuild on real workspaces (BM25 is a tantivy commit per chunk, cheap; embedding scales linearly with chunk count and waits on the model). To avoid throwing that work away on a crash, the per-file vector shard carries a `body_hash` field (sha256 over the canonical `(chunk_id, body)` sequence) stamped at write time. On the next `build_all`, the per-file path re-chunks from disk, computes a fresh `body_hash`, and asks the on-disk shard for its `(model, body_hash)` pair; on match the file skips the embed queue (the vectors are still valid because identical chunks under the same model deterministically produce identical embeddings). The count of files that took the skip path surfaces as `BuildSummary.embeds_reused`, so the CLI and tests can observe partial-rebuild resumption rather than infer it.

Each per-file shard under `embeddings/` carries its own `FORMAT_VERSION` (currently 2), checked per shard in `load_all`; a mismatch drops the shard silently and the next `build_all` re-embeds that file. This is intentionally independent of the schema-version wipe path: a shard-format bump should NOT invalidate BM25 segments or other shards, only the shards that actually need re-encoding. The `--no-default-features` build excludes the entire embed path including the skip check; the `embeds_reused` field stays in `BuildSummary` and reads zero.

#### Embed batch cadence and the CPU backend

`build_all` accumulates parsed chunks across files and flushes them to the embedder in `EMBED_BATCH_CHUNKS`-sized groups (the value comes from `SearchAggression::budget()`: 64 / 128 / 256 chunks for Conservative / Balanced / Aggressive). Each flush first commits the BM25 writer, then runs one blocking forward pass over the batch and writes the resulting per-file vector shards. Committing per flush is what makes `indexed_vectors`, the `reindex_with` progress events, and the BM25->hybrid search upgrade advance incrementally as a long cold build runs, instead of landing only when the whole pass returns: a large cold reindex would otherwise report zero vectors and a frozen progress chip for the minutes the embed takes. The cadence is deliberately kept below a typical workspace's chunk count (chunks-per-file is usually ~10), so a cold build commits in several visible steps rather than one tail flush. The batch size is a flush/commit cadence only -- the embedder always runs `INFER_BATCH`-sized forward passes internally -- so it carries no embedding-throughput cost.

Embedding runs on CPU by default: the candle Metal backend exhausts GPU memory and stalls on large workspaces, so the GPU path is opt-in via `CHAN_ENABLE_GPU=1`. On macOS the CPU path links Apple's Accelerate framework as candle's BLAS backend -- the target-gated `accelerate` feature, wired alongside `metal` under `cfg(target_os = "macos")` -- routing bge-small's matmuls through Accelerate's `sgemm` for a measured ~1.5-2x cold-reindex speedup over candle's default SIMD-threaded `gemm` (modest because the default is already vectorized, and the forward pass also spends time in non-matmul ops). The feature pulls the Apple-only `accelerate-src`, so the static-musl Linux release binary structurally cannot pull it in.

#### Generated index scope

`IndexScopePolicy` (in `fs_ops`) is one immutable scope value per `WorkspaceGeneration`. It encodes explicit `Include`, `Exclude(Hard | Gitignore | Configured)`, and `VcsControl` decisions. `.chan`, `.git`, `.hg`, and `.svn` internals are hard exclusions; watcher dispatch alone forwards `.git/HEAD`, `.git/index`, and `.hg/dirstate`. `.svn` checkout detection is unsupported because there is no stable narrow control file to forward. The machine-wide configured baseline lives in `Registry::index_excluded_dirs` and is persisted to `~/.chan/config.toml`; the per-workspace `IndexConfig::excluded_dirs` additions are unioned into the same policy. Configured matching remains exact directory basename at any depth, ASCII case-insensitive, so registry migration and user settings retain their established meaning.

`Registry::drafts_dir` (default `.Drafts`) is modeled the same way as `index_excluded_dirs`: a global field in `~/.chan/config.toml`, hand-edited, not exposed through any UI. It names the in-tree Drafts directory rather than a skip target, so it is deliberately NOT on the walk filter: drafts are real in-tree content and index and graph like any other file.

The same policy Arc is sampled by bootstrap, filtered listing, graph, BM25, reconcile, report, Linux watch registration and dynamic registration, and watcher dispatch. Full walks do not follow symlinks and stay on the workspace root filesystem; Linux registration compares every candidate directory's device identity with its `WatchRoot` before registering or descending. A gitignore negation keeps a configured-excluded directory traversable only when the pattern's fixed prefix can match within that directory; an unrelated negation cannot widen every configured exclusion. `Workspace::set_excluded_dirs` persists the setting, advances the shared recovery generation, swaps a new immutable policy, and requests reconcile. Watch registration observes replacements, resets registrations when a replacement races a retry, and discards queued directory work tagged with an older generation. The editor-visible raw `Workspace::list_tree` and `Workspace::list` APIs remain unfiltered so a user can deliberately open a file inside a noisy directory.

### Graph

`sqlite` (rusqlite, bundled) backs the per-workspace graph in sidecar state. Schema lives in `nodes` (files), `edges` (links + tags + mentions), and `headings` (in-file anchors). A `nodes` row carries `rel_path`, `kind` (`file` / `contact`), `mtime`, `size`, `title`, `basename`, `emails` (lowercased addresses extracted from contact bodies), and `aliases` (top-level `aliases:` frontmatter, used by the mention resolver to map `@@<alias>` to a contact file without re-parsing frontmatter per query). Edge rows are `(src, dst, kind, anchor)` with the anchor in the primary key so one file can link the same target via two distinct anchors.

Single-writer semantics, multi-reader: the writer connection sits behind a `Mutex<Connection>` (sqlite's contract); reads pull from an `r2d2::Pool<SqliteConnectionManager>` so editor link-autocomplete queries do not queue behind a reindex write or another typeahead. WAL mode plus a uniform per-connection PRAGMA init keep the writer and the pool agreeing on `journal_mode`, `busy_timeout`, and `synchronous`.

`replace_file` inserts outgoing edges (links + tag/mention tokens) and headings with computed anchors. `forget_file` removes a file and all its edges; `forget_under` does the same for a directory prefix. `clear` wipes everything for a full rebuild. Full rebuilds parse into staging tables and swap atomically; see "Schema versioning" for the resumability model. Read surface: `neighbors`, link-only `backlinks`, bind-batched semantic `edges_from` / `edges_to`, `tags`, `mentions`, `files_with_tag`, `files`, `files_with_stat`, `node_kind`, `headings_of`, `link_targets`, `contacts`, `contacts_filtered`. `graph_normalize` projects authored link and mention destinations onto canonical graph IDs at query time. It resolves percent-encoded and relative link targets against supplied filesystem metadata and resolves mentions from supplied contact rows without writing derived values back to SQLite. Mention collisions retain every candidate while selecting the final `GraphView::contacts()` candidate for compatibility with the visualization graph.

#### Link resolution

Two path forms coexist in chan-workspace on purpose. The Workspace API (`read`, `write_text`, `list`, MCP tool `path` args, graph row keys) speaks one canonical form: a workspace-rooted POSIX rel path with no leading slash and no `..`. Inside markdown bodies the user (or an agent) writes hrefs in whatever form the renderer expects, which for GitHub-style markdown is "relative to the file that contains the link" so the document keeps rendering when viewed outside chan (GitHub web, Obsidian, a pasted preview). The normalizer below is the bridge: file bodies stay portable, the graph and queries see one canonical destination.

Markdown link hrefs and image embeds (`[label](href)`, `![alt](src)`) are run through `markdown::normalize_href` before the graph builder writes the edge `dst`. The normalizer is a pure function: input is `(href, source_dir)`, output is `Option<String>` (clean workspace-relative POSIX path; `None` for external schemes, fragment-only refs, empty hrefs, and lexical escapes past the workspace root).

Resolution rules, in order:

1. Fragment-only `#anchor` refs return `None` (intra-document).
2. URL schemes (`https:`, `mailto:`, `tel:`, ...) detected by a `:` ahead of any `/` `#` `?` return `None`.
3. Trailing `?query` and `#anchor` are stripped; the anchor is preserved separately on the edge's `anchor` column.
4. Hrefs starting with `/` are workspace-rooted (the leading slash is stripped); otherwise the href is joined to `source_dir`.
5. `.` / `..` segments collapse lexically. A `..` past the workspace root returns `None`; chan-workspace's no-symlink sandbox rules out symlink chasing here as well.

Wiki-link targets (`[[name]]`) keep the picker's existing workspace-rooted-by-default convention: bare `[[Contacts/Jane]]` resolves to `Contacts/Jane`, an explicit `[[/Contacts/Jane]]` likewise. Targets prefixed with `./` or `..` opt into source-relative resolution (`[[../foo]]` from `notes/x.md` walks up to `foo`).

The same normalizer ships as a hand-port to TS for the editor's click handler so on-disk edges and in-editor navigation agree on the resolved path.

#### Link autocomplete (`[[`)

`link_targets` backs the editor's `[[` typeahead: the user types a fragment and gets back files plus headings to anchor a wiki link to. The graph DB is the source of truth (`nodes` for files, `headings` for in-file anchors); BM25 over heading and body text in the search index serves a parallel purpose for free-text search but is not used for the picker.

Each link target is either a file or a heading. Both carry the file path; file targets may include title and mtime, while heading targets carry heading text, anchor, and depth. This shape lets the picker render a single mixed list without issuing a second query for heading metadata.

  - **Empty `q`**: most-recently-edited files first, up to `limit`. Useful as the picker's initial state before any keystroke.
  - **Non-empty `q`**: four-tier ASCII case-insensitive match.

      rank 1  basename starts with q   ("carb" -> "carbonara.md")
      rank 2  basename contains q      ("bona" -> "carbonara.md")
      rank 3  title contains q         (h1 / frontmatter title hit)
      rank 4  heading text contains q  (in-file anchor target)

    Within a rank, files sort by `mtime DESC NULLS LAST, rel_path ASC`; headings sort by `rel_path, ord`. Heading hits are capped at `limit / 2` so a single TOC-heavy file cannot drown out file matches.

  - **Wildcard escaping**: `%`, `_`, and `\` in `q` are escaped against SQLite's LIKE engine so a filename "100%off.md" is not matched by a raw `%` query.
  - **Case folding**: ASCII only. SQLite's `LOWER` does not fold Unicode without ICU; non-ASCII queries match case-sensitively. Acceptable for a single-user picker; revisit if a Unicode-aware backend becomes a priority.

After picking a file, the editor calls `GraphView::headings_of(rel)` to populate the `[[file#` second phase from that file alone.

### Watcher

`Workspace::watch` returns an owned `WatchHandle`. Initial root and recursive registration complete before return; partial registration returns `WatchHealthState::Degraded`, emits `ProviderError`, and retries under the owned supervisor. Backend provider loss also marks the handle degraded and re-registers the roots. Successful retry restores healthy state. `stop()` is idempotent and joins the supervisor before returning, `join()` requests the same synchronous teardown, and drop applies the same rule, so no registrar or notify callback thread is detached.

Callback-based on purpose: the Swift / Kotlin shell implements the trait by passing an `Arc<dyn WatchCallback>` (uniffi generates a wrapper around a foreign object). No closures cross the FFI.

The dispatch filter calls the active `IndexScopePolicy`, with two watcher-specific deviations:

  - Hard `.chan` and VCS internals are never configurable.
  - Exact VCS control decisions (`.git/HEAD`, `.git/index`, `.hg/dirstate`) are forwarded because the indexer keys checkout-storm detection off them, while all walks prune their parent metadata directories.

Every event carries the policy `WorkspaceGeneration` sampled at dispatch, and stale generations are rejected by the graph and report consumers. `is_dir` preserves directory identity even for Linux `MOVED_FROM` events whose source has already vanished. Rename events expose the Linux inotify correlation `cookie`; it remains `None` on other backends and synthetic events. A path that cannot be mapped into any watched root is emitted as a pathless `ProviderError` loss event so consumers reconcile instead of silently dropping an unknown mutation.

When the report subsystem is active, the same watcher fan-outs each event into the report's incremental index before the user's callback runs (see "Report").

### Built-in graph indexer

`Workspace::start_graph_indexer(debounce_ms)` returns a `GraphIndexer` handle that owns a watcher subscription and one worker thread, so consumers (CLI, chan-server, native shells) do not each reinvent the same queue. `DEFAULT_DEBOUNCE_MS` is 150.

  - Debouncing is per-path, trailing-edge: the first event for a path schedules a deadline at `now + debounce`; further events push it forward; the deadline maturing triggers `index_file`.
  - `Removed` events and the source side of `Renamed` skip the debounce: a stale graph row pointing at a missing file is the user-visible failure mode, so deletions flush immediately. Directory events forget every graph and search row at or below the source path through the same journaled mutation boundary.
  - `ProviderError` and path-less events (the watcher's "scope unknown" signal) clear the pending map and trigger a full `Workspace::reconcile`, the same convergence path used for cold-open catch-up.
  - Counters (`pending_count`, `indexed_total`, `forgotten_total`, `reconciles_total`) back the status surface. Drop the handle (or call `stop()`) to tear down synchronously: watcher first (closing the channel), then the worker joined.

```mermaid
flowchart TD
  Notify["notify event on watcher thread"] --> Filter{"IndexScopePolicy::decision(rel)"}
  Filter -->|"VCS control file -- force-forwarded"| Send
  Filter -->|".chan internal -- always dropped"| Drop["event dropped"]
  Filter -->|"excluded dir component -- dropped"| Drop
  Filter -->|"ordinary path"| Send["mpsc channel to indexer worker"]
  Send --> Apply{"apply_event by WatchKind"}
  Apply -->|"Modified / Created with path"| Sched["schedule_pending: now + debounce"]
  Apply -->|"Removed"| Forget["forget_file immediately"]
  Apply -->|"Renamed"| Rename["forget_file(src) now + schedule_pending(dst)"]
  Apply -->|"ProviderError or path-less"| Recon["clear pending + Workspace::reconcile"]
  Sched --> Deadline{"deadline matured?"}
  Rename --> Deadline
  Deadline -->|"newer event -- push deadline forward"| Sched
  Deadline -->|"matured"| Index["index_file"]
```

*notify events pass one shared ignore set (.chan dropped, VCS control files force-forwarded), then the indexer worker per-path trailing-edge debounces edits, flushes Removed/rename-source immediately, and clears pending plus full-reconciles on ProviderError/path-less events.*

### Bootstrap snapshot

`Workspace::bootstrap()` returns a lightweight structural snapshot (directory tree shape, file counts, byte sizes) that the UI can render immediately on open, before any index or report job runs. It is a STAT-ONLY walk: no file content is read, no graph edge is parsed, so it does not pressure the fd budget the way the index / report jobs do. It honors the same `WalkFilter` as the indexer (one ignore policy), while the on-demand listing APIs stay unfiltered. The root response carries the first level eagerly (root files + dirs, each dir with recursive subtree stats) plus whole-workspace aggregates; deeper levels load lazily via `Workspace::bootstrap_dir(rel)` on File Browser expand or Graph depth-increase.

### Report

The per-workspace code/SLOC/COCOMO report wraps `chan-report`'s incremental `Index`. chan-workspace owns the persisted JSONL, the load-else-rescan open path (any load error -- missing file, schema mismatch, partial write -- falls back to a full scan that replaces the bad file on the next flush), and a dedicated writer thread that debounces flush signals (500 ms window) and atomic-writes the JSONL. Watch events fan into the in-memory index before the user's callback runs, so a handler that immediately calls `Workspace::report()` sees the change; `Unchanged` outcomes do not schedule a write. The walk applies the same excluded-dirs policy as the index walk so a source-tree workspace doesn't roll up its dependency trees.

The report read side supports whole-tree, prefix, explicit-file, and O(1) directory summaries; untracked directories return `None` so HTTP callers can distinguish "empty/untracked" from "tracked zero." The subsystem is gated by the per-workspace `reports_enabled` flag and activated by `Workspace::boot()`, which consumers call after open to kick off optional layers.

### Contacts

Imports a third-party contact dump (Google Contacts CSV) as one markdown note per contact.

On-disk shape: slim YAML frontmatter holding only top-level `aliases` plus the chan-internal `chan:` block (`kind: contact`, `provider`, `imported_at`, `frontmatter_version`, optional `remote_id`); contact data (emails, phones, organizations, labels) lives in the body as bullet items so a chan editor that doesn't strip frontmatter shows a friendly note rather than a YAML dump.

Indexer reads the frontmatter in `parse_for_graph` to tag the corresponding `nodes` row as `kind = 'contact'`. Same row, different kind: backlinks, link-autocomplete, and forget_file all keep working unchanged because they key on `rel_path`, not `kind`. Downstream consumers (`Workspace::contacts`, editor `@` picker, `GET /api/contacts`) filter on `kind = 'contact'` to surface contacts as a distinct UI surface.

The contacts module splits into pure parser/emitter/slug helpers behind one orchestrator. The import orchestrator is exposed as `Workspace::import_contacts` (and `import_contacts_with` for progress reporting) so the import flow inherits the path sandbox, editable-text gate, and atomic-rename rules. One bad contact does not abort a batch: per-file errors land in `ImportSummary` as `Failed` outcomes.

Imported notes are user-owned the moment they land. chan does not re-edit them. Re-importing either skips existing files or overwrites them (per `ImportOpts.overwrite`); there is no merge.

Filename strategy: derive from `display_name`, fall back to first email local-part, then `phone-<digits>`, then `unnamed-N`. Sanitize path separators / control chars / Windows-reserved chars to `_`. Trim to 120 bytes UTF-8-safely. On collision within a batch, append ` (2)`, ` (3)`, etc. before the `.md`.

Non-goals: OAuth, API integration, two-way sync, on-disk cache, other provider formats. Contact notes ARE the source of truth; the existing markdown indexer covers read.

Contact-aware filtering for the editor `@` picker and `GET /api/contacts` lives at the SQL layer: `GraphView::contacts_filtered(query, limit)` runs a case-insensitive `LIKE` against `title`, `basename`, and the `emails` column with the limit applied inside SQLite, so per-keystroke calls stay O(limit) instead of O(N). A typed `alice` finds both "Alice Anderson" and a contact whose only `alice` is in `alice@example.com`; the deduplicated email list comes back so the picker can render a secondary line under the contact's name. `GraphView::contacts()` is a convenience wrapper for callers that want the full list.

The `emails` column is populated as contacts are parsed during a walk: the indexer's first pass over a fresh workspace fills it in for every contact-kind file, and per-file edits update it through `replace_file`. Contacts that lack an email body section keep `emails IS NULL` and simply don't match email-substring queries. The `aliases` column is populated the same way from top-level frontmatter and serves the `@@<alias>` mention resolver.

Discovery is content-driven, not directory-driven. Any `.md` file whose frontmatter has nested `chan: { kind: contact }` is classified as `NodeKind::Contact` regardless of where it sits in the workspace. A user who hand-rolls a contact note in their own directory and drops it in is picked up by the next indexer pass; the `Contacts/` directory is just the importer's default destination, not a discovery requirement.

The chan-llm tool sandbox (and the MCP server it backs) exposes contact lookup through the canonical `workspace_search` contract rather than a contacts-only tool. Typed contact and mention selectors share the graph normalizer and return the same structured ambiguity and traversal results as HTTP/control-socket consumers; `read_file` remains the path for reading the selected contact note.

### Metadata archive

`metadata_archive` exports and imports the per-workspace sidecar state as a zstd-compressed tar so search/graph/report caches and session blobs can move between machines (or serve as a backup) without re-deriving them. The archive has a versioned manifest plus payloads keyed by the same canonical-path slug + sha256 scheme as the metadata key. It includes cache/session sidecars and excludes locks, machine-local tokens, trash, and transient staging/temp files. Entry paths are validated on both sides (`validate_archive_entry_path`) so a crafted archive cannot write outside the payload root. The manifest records the archive format version, the producing chan version, and per-workspace identity so import can match payloads to registry rows.

### Teams config

`teams` is a schema-only module: `TeamConfig` (team name, host name/handle, terminal tab group, `@`-prefix policy, MCP-env opt-in) plus `Member` / `Position`. The struct is persisted to a `config.toml` next to the team's working files and consumed by chan-server's `/api/team-config/read` and `/api/team-config/write` routes; chan-workspace owns the shape so serialization stays uniform across consumers, but no team behavior lives here.

## 4. Interface contracts

Code is the source of truth for signatures; this section records the contracts consumers rely on.

### Library lifecycle

`Library` is the registry boundary. It opens the platform config, resolves canonical roots, preserves metadata keys across moves, and holds machine-wide policy such as the walk filter and drafts directory name. Registering an already-known root is idempotent; unregister/reset require no live `Workspace` handle for the target and never touch user content. Orphan sweeping only reclaims sidecars with no registry row.

### Workspace content

Every workspace operation takes a workspace-relative POSIX path and goes through the sandbox resolver. Text reads/writes additionally pass the editable-text gate; byte reads/writes bypass that gate but still require regular files under the workspace. CAS writes compare the open-time mtime token, soft delete routes through Trash, and link-rewrite only edits markdown-class bodies. Physical path resolution is metadata-only: it maps a public path to a host path for shell/MCP use without reading content.

Opaque file delivery uses `BoundedFileReader`: one open handle and 64 KiB chunks read on the consumer's own thread. A whole-file reader freezes its byte window from the open handle's stat; later growth is excluded from that representation and later shrinkage produces an error instead of a short successful stream. Slice readers clamp their requested window against the same open-handle size and expose the effective `(start, len)` for HTTP framing. Directory archives consume this reader through a `Read` adapter, so no tar member is materialized as one allocation.

`TEXT_WRITE_LIMIT` (2 MiB) caps a single text write for new files; `semantic_write_budget(existing_size)` raises that budget only to the existing size so a legacy large file remains editable without further growth. Byte writes follow the same intentional legacy-file rule against the workspace's configured transfer ceiling rather than a compiled-in constant: the effective budget is `max(existing_size, Workspace::transfer_max_bytes())`, so lowering the ceiling cannot turn an existing larger file read-only. That ceiling is `[transfer] max_bytes` in the registry (10 GiB by default, 100 GiB maximum, zero rejected), captured once when the `Library` opens and reported to clients as one effective value, so no caller keeps an independent copy. The progressive sink rejects the first chunk that would cross the effective budget with `ChanError::WriteTooLarge`.

The editor-session recovery reader in chan-server carries a separate 50 MiB bound that deliberately does not track the transfer ceiling. A recovery record is read whole into memory when a file is opened, so its bound is an allocation bound; pointing it at a multi-gigabyte transfer ceiling would make a corrupt record a multi-gigabyte allocation on the editor-open path. Tree listings cap at `LIST_TREE_LIMIT` (500k entries) and per-dir listings at `LIST_DIR_LIMIT` (50k); exceeding callers get `ListingTooLarge`.

`Workspace::copy` connects `BoundedFileReader` directly to the bytes-mode atomic sink. A new copy therefore inherits the 50 MiB binary budget, incremental UTF-8 validation when the destination is editable text, same-directory atomic commit, and temp cleanup on source or sink failure. The source's open-handle size is checked against the sink budget before the first chunk is accepted.

Drafts, session blobs, contact import, trash restore/purge, and bootstrap snapshots are all layered on the same path, atomic-write, and walk-filter rules rather than bypassing the workspace boundary.

### Search, graph, report, watch

Search and graph sidecars are metadata-opened during workspace construction so readiness can be classified without visiting the workspace tree. Report state remains lazy unless a persisted report needs startup recovery. Explicit reindex calls are synchronous; startup replay, rebuild, reconcile, and persisted-report rescan run on the workspace's owned blocking worker. The built-in watcher/indexer remains optional and uses the same scope policy as the cold paths. Graph writes serialize through the graph writer connection; graph reads use the reader pool. Report state is opt-in, watcher-fed before user callbacks run, and persisted through chan-report JSONL. `report_if_available` is the non-scanning read path: it returns a warm snapshot or loads a valid persisted JSONL and otherwise returns `None`; unlike `report()`, it never falls back to a filesystem scan.

One workspace `write_serial` mutex is the derived-state mutation boundary. It covers per-file graph/BM25 index and forget, pending-journal replay, reconcile as one unit, full rebuild, and warm report watcher updates. Nested bulk paths call lock-assuming per-file helpers, so they do not reacquire the non-reentrant mutex. Incremental `index_file` stats included `.md` and `.txt` files before this lock and declines files larger than `TEXT_WRITE_LIMIT`; lock-owning callers repeat the same gate before reading. Search, graph, report snapshot reads, filesystem reads, and bounded file streams never take this lock.

Per-workspace settings live in the workspace sidecar rather than an app-specific preference file. Search mode, report enablement, and screensaver policy use `dashboard.toml`; per-workspace excluded dirs remain in the index config.

### Progress and recovery

Long-running operations (reindex, rename with link rewrite, contacts import, workspace reset, embedding model load) report progress through one umbrella callback type. The same sink shape carries every stage, so a consumer (chan-server's WebSocket fan-out, the CLI's progress bar, future native shells) wires one listener instead of one per op.

Progress events carry a stage, current count, total count (`0` means indeterminate), optional label, and optional `eta_secs`. Stage names are the wire vocabulary: `GraphRebuild`, `IndexFile`, `EmbedBatch`, `RenameRewrite`, `Import`, `Reset`, `ModelLoad`, and `Heartbeat`.

`eta_secs` is a hint from the producer. It is computed from `elapsed_since_start * (total - current) / current`, so it trends down smoothly with average rate rather than the instantaneous one (no zig-zag from a hot stretch of small files or a cold stretch hitting an embed batch). Producers leave it `None` until the first item completes and on stages where rate is meaningless (`ModelLoad`, `Heartbeat`). Consumers must treat the field as advisory.

`ProgressEvent` and `ProgressStage` derive `Serialize` / `Deserialize`. The wire shape is the field names verbatim with `stage` serialized as its PascalCase variant name (`"IndexFile"`, `"GraphRebuild"`, etc.). `label: None` serializes as JSON `null`. A dedicated serialization test pins the shape so a future change is an explicit edit, not silent breakage of every connected client.

Push vs. pull, and how the signals relate:

  - `ProgressCallback::on_progress` is the push side: zero or more events per long-running call, fired on the producer's thread. Events are best-effort hints, not a stream contract; a slow consumer may drop ticks. The on-disk state is the authority.
  - `Workspace::recovery_status()` is the authoritative pull side. One short-lived mutex owns only the current `WorkspaceGeneration`, the last completed generation, one active `RecoveryPass`, and one pending pass. The mutex is never held across replay, reconcile, or rebuild work. `is_ready()` requires no active or pending pass and `completed_generation >= generation`; `required_action()` reports pending work before active work.
  - `request_recovery` coalesces repeated lossy signals such as `ProviderError` into one pending generation and upgrades the action by `FullRebuild > Reconcile > Replay`. A signal arriving during an active pass creates exactly one newer pending generation, so it cannot be cleared by completion of stale work. `request_policy_recovery` always advances the generation because each immutable policy replacement needs a distinct tag, while pending work still collapses onto the newest tag.
  - `begin_recovery` moves pending work into the single active slot and `finish_recovery` either completes that generation or requeues it without inventing a new one. `Workspace::is_reindexing()`, `needs_rebuild()`, and `needs_replay_writes()` are projections of the coordinator.
  - chan-server requests recovery before enqueueing the returned `WorkspaceGeneration`. Its rebuild coordinator drains queued requests to the newest required generation, claims and finishes each pass through the workspace coordinator, and exposes idle only after the completed generation covers that requirement with no pending work. `Workspace::run_full_rebuild_pass` is the narrow seam for an already-claimed server pass. A trigger during a rebuild therefore requires one follow-up pass, repeated triggers coalesce onto it, and the rebuild cooldown remains a floor before that follow-up starts.
  - `Workspace::readiness()` projects one coordinator snapshot into the serde-tagged `WorkspaceReadiness::{Ready, Recovering}` value consumed by server, desktop, and CLI. Recovering carries the required, completed, active, and pending generations plus the dominant required action, without exposing the coordinator mutex or worker. Server status, indexing-state, and preflight responses carry the same value. Content and unified workspace queries conservatively return explicit not-ready envelopes with no derived rows during recovery; no readable snapshot generation is claimed, because graph, BM25, and report do not persist one shared completion proof.
  - `Workspace::open` returns a metadata-only `RecoveryPlan` with the durable marker/journal inputs, graph and search readiness, policy generation, and persisted-report state. `Library::open_workspace` starts the owned recovery worker only after construction returns. A warm populated pair schedules reconcile; a stale rebuild marker or graph-populated/search-empty pair schedules full rebuild; a pending journal schedules replay; an empty cold pair skips the tree. A persisted report is rescanned on that same worker. The durable files remain the cross-process authority, and `RecoveryStatus` stays pending/active until the derived-state pass finishes.
  - `Workspace::reconcile()` is the diff-based recovery path. Walks the live tree, compares each editable-text file's mtime against the graph row, and emits journal-bracketed `index_file` / `forget_file` calls only for the deltas. Unchanged files are skipped, so reconcile costs O(N) stat + the per-file embed only for changed files. Use cases: cold open after offline edits, watcher-overflow recovery (inotify `IN_Q_OVERFLOW` / FSEvents coalesce-loss), post-`replay_pending_writes` sanity. The diff compares `(mtime, size)` tuples against the graph's stamped row; a same-mtime-different-size rewrite is caught via the size delta. Rows that carry `size = NULL` (stamped before a size was recorded) fall back to mtime-only for that row, and a subsequent `index_file` backfills size.
  - `pending_writes.json` stores a `(rel, op)` pair written by `index_file` / `forget_file` before either backend is touched and removed after both commit. A crash between graph and search commits leaves the entry behind; `Workspace::replay_pending_writes()` re-runs journaled ops against current on-disk truth. `Index` entries degrade to `forget` when the file no longer exists; `forget` entries are idempotent against an already-cleaned backend.

```mermaid
stateDiagram-v2
    [*] --> Open
    state "Ready: completed >= current" as Ready
    state "Pending generation N" as Pending
    state "Active generation N" as Active
    state "Pending generation N+1" as Newer

    Open --> Pending : marker, journal, or warm sidecars
    Open --> Ready : empty cold sidecars
    Ready --> Pending : provider or policy signal
    Pending --> Active : begin_recovery
    Active --> Newer : signal during active pass
    Active --> Ready : complete, no newer pending
    Active --> Pending : retry same generation
    Newer --> Pending : complete stale active pass

    note right of Active
      coordinator mutex released during work
      stale tags cannot clear newer pending work
    end note
```

*Durable markers seed recovery, monotonic generations prevent stale completion, and coalescing keeps repeated provider loss bounded to one required follow-up pass.*

Cardinality is per-file for `IndexFile` / `RenameRewrite` / `GraphRebuild` and per-batch for `EmbedBatch`; on a 10k-file workspace a full reindex can push tens of thousands of events. Consumers that fan out over a transport (chan-server WebSocket, native FFI bridge) should coalesce or rate-limit upstream of the socket; the producer side does not throttle.

### Contacts

The contact importer separates parsing, markdown emission, slug allocation, and workspace writes. Provider support is explicit; today Google CSV is the only provider. Import outcomes distinguish wrote, overwrote, skipped, and failed entries so one bad contact does not abort a batch. Graph projection stays ordinary file-node state with a `Contact` node kind layered on top.

### VCS detection

Pure stat-walk. `detect_parent_vcs` is used by `chan open` (and any future shell) to decide whether a workspace path is inside a Git / Mercurial / Subversion working tree and would be better served at the repo root instead of an arbitrary subdir. `detect_workspace_vcs` answers "is the root itself a checkout". `is_vcs_control_path` recognizes the control files the watcher forwards (`.git/HEAD`, `.git/index`, `.hg/dirstate`).

`detect_parent_vcs` algorithm:

  - Canonicalize the input. Skip the leaf (we report only strict ancestors so a user who picked the repo root sees `None`).
  - For each ancestor, check for `.git` (real directory OR real regular file; the file form covers worktrees and submodules), `.hg/`, `.svn/`. First match wins.
  - Marker checks use `symlink_metadata` (lstat) plus a file-type gate: symlinks, FIFOs, sockets, char/block devices at `.git` / `.hg` / `.svn` are rejected. Same "lstat, never stat, on user paths" invariant the rest of the crate enforces; a planted symlink or special file can't fool the suggestion.
  - Stop at: a mount boundary (`st_dev` change on Unix; skipped on Windows), at `$HOME` (never inspected; dotfiles-as-git is unrelated to workspace-root selection), or at the filesystem root.

The function never invokes `git`/`hg`/`svn` and never reads repository contents. The shell layer (`chan open`, desktop) is responsible for the user-facing decision (refuse and suggest the repo root, present a dialog, accept an explicit override).

Foreign-language boundary: exported data is owned (no lifetimes) and `Send + Sync`. Watch and progress events derive `Serialize` / `Deserialize` so a consumer can forward them across a WebSocket / FFI bridge without an intermediate copy type.

## 5. Invariants and trust boundaries

### Sandbox and path resolution

  - Every Workspace entry point uses `fs_ops::resolve_safe_strict` (lexical sandbox plus a canonical-form check on the deepest existing ancestor). New entry points must do the same. The strict variant catches mid-path symlinks pointing outside the workspace.
  - `lstat`, never `stat`, on user paths: `read` / `write` / `stat` / `remove` use `fs_ops::ensure_regular_file` or `std::fs::symlink_metadata` so a symlink target can't mask the link. New ops touching user content must apply the same gate.
  - The editor gate (`is_editable_text` plus the content-sniff fallback) guards `read_text` / `write_text`; binary callers use `read` / `write_bytes`. The narrower `fs_ops::is_indexable_text(rel)` is the indexer gate: true only for `FileClass::EditableText` (.md / .txt), used by the search index, graph rebuild, and link-rewrite on rename.
  - The crate also uses `cap-std` / `cap-tempfile` for sandboxed Dir-relative reads and atomic writes on hot paths, closing the TOCTOU window between resolve and open by anchoring the open at a pre-validated `Dir` handle.
  - **Stat before read in `index_file`**: `Workspace::index_file_inner` stats the file (capturing `(mtime, size)`) BEFORE reading its content. A concurrent writer that lands in the window between the two then leaves the graph holding the older stat tuple with the newer content; `Workspace::reconcile`'s next pass sees `graph.stat != disk.stat` and re-runs the file. Read-then-stat would do the opposite, stamping the post-write tuple onto the pre-write content; reconcile's diff would match and the drift would persist until a full reindex. The stamped tuple is thus a strictly conservative lower bound on the freshness of the indexed state.

### Symlink and special-file policy

The Workspace entry points enforce three rules so the layer never accidentally hangs on, follows, or mutates a non-regular file:

1. **Mid-path symlinks**: rejected when their canonical target leaves the workspace. In-workspace symlinks (`alias -> ./real`) pass the path-resolve leg.
2. **Final-component symlinks**: rejected by every read / write op. Atomic rename would otherwise replace the link with a regular file (silently breaking the user's intentional alias), and reads would traverse the link off-disk. Users who want to write through a symlink delete the link first.
3. **FIFOs, sockets, char/block devices**: rejected by every op via the `lstat`-based gate. These types can't appear in a note workflow; if they do, it's either a misconfiguration or abuse of the read/write API. Without the gate, opening a FIFO blocks waiting for a writer; opening `/dev/zero` never returns; opening a device sends ioctl-shaped reads.

Walker invariants:

  - `walkdir::follow_links(false)` and `same_file_system(true)` so symlink loops can't occur and a misregistered workspace that spans onto a network mount won't drag the indexer into it.
  - Iteration drops non-regular non-dir entries, so the UI tree and the indexer only ever see real files and dirs.

What's NOT closed today:

  - Pure-libstd TOCTOU on cold paths: a path that passes the strict resolve could in principle be swapped for a symlink before a non-cap-std open syscall. The hot reader/writer paths use cap-std and so close this; cold paths rely on the strict resolve plus single-user threat model. Closing fully on Linux requires `openat2(2)` with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS` (Linux 5.6+) or per-component `O_NOFOLLOW` on platforms without openat2.

### Atomic writes

Anything chan-workspace-managed (registry, sessions, blob storage, graph control records, atomic-write user files) routes through `fs_ops::atomic_write` or the cap-std streaming core shared by `atomic_write_in` and `Workspace::write_atomic_stream`: tmpfile in the same directory, progressive writes, fsync the file, rename into place, fsync the directory. Mode + xattrs (Finder tags on macOS, SELinux labels and capabilities on Linux) are captured from the existing target before the rename and restored on the new file. Never `std::fs::write` directly to the target. A crash mid-write must produce zero state for the writer plus an intact previous version.

### Locking model

Registration and open operations coordinate through the registry mutex and the cross-process workspace lock. Reads avoid the cross-process lock and rely on safe path resolution plus reader-safe tantivy/sqlite handles. Writes use atomic replacement or the graph writer mutex, depending on whether the target is a filesystem entry or graph state.

Two distinct concurrency primitives:

  - `WorkspaceLock` (cross-process): held for the lifetime of `Workspace`. A second process opening the same workspace errors immediately with `ChanError::WorkspaceLocked`; we do NOT block. Callers handle the error explicitly (CLI prints a message and exits; desktop app falls back to opening another workspace).
  - `lock::is_locked_by_foreign_holder` is the non-blocking read-side probe for UI status. It does not acquire for ownership and does not steal; it reports foreign-locked only when the writer lock is contended by a live, indeterminate, torn-record, or path-mismatched holder. Free locks, this process's own holder, and provably dead holders stay actionable.
  - `Mutex<Registry>`, `Mutex<Connection>` (graph writer), and the r2d2 pool (graph readers): intra-process. Cheap.

Reading does not take the cross-process lock. tantivy is multi-reader-safe by design; sqlite WAL mode plus the r2d2 reader pool lets concurrent readers proceed alongside the writer.

### Workspace-internal noise filter

Apart from the drafts directory (deliberate, user-visible, configurable), chan-workspace stores ZERO files inside the user's workspace directory. This makes it safe to drop a workspace inside an existing git repo, an iCloud / Google Drive / Dropbox directory, or anywhere else. Editor-session recovery is the one in-tree exception, and it is chan-server's write, not chan-workspace's: chan-server records recovery state under `.chan/editor-sessions/v1/` through the workspace atomic stream writer (`write_atomic_stream`), and those records are filtered from walk and index like `.git/`. A stray `.chan/` left over from an older install or created by a third-party tool is filtered out by `walk_workspace` and the watcher dispatch; chan-workspace never emits events for it or includes it in `list_tree`.

## 6. State placement

chan-workspace keeps user content and machine-local state separate. The registry, global walk policy, and drafts-directory name live under the platform config directory; per-workspace sidecars live under a metadata root keyed by the registry row. Those sidecars hold chan-managed state only: search/graph/report caches, session blobs, app tokens, the writer lock, and the per-workspace Trash.

The metadata key is the path slug plus an 8-hex hash of the canonical path at first registration. `Library::move_workspace` preserves it when the local path moves, so sidecars follow the workspace logically without moving files on disk.

Desktop targets (macOS, Linux, Windows) use `~/.chan` or the home-equivalent for config, state, and cache alike: one visible directory, easy to inspect and delete. iOS and Android collapse `config_dir` onto the app-sandbox state dir because the home dir inside the sandbox is not user-writable and the "brand-visible" argument for `~/.chan/` does not apply on mobile.

Drafts are the deliberate exception to "no chan state in the workspace root." They live in-tree as a real hidden directory named by `Registry::drafts_dir` (default `.Drafts`), created lazily on first Cmd+N, and are indexed/graphed like ordinary content. The walker still hard-skips `.git` and `.chan` and honors the effective excluded-dirs set; `.Drafts` is not on the skip list.

## 7. Error model

One umbrella `ChanError` enum so the Swift / Kotlin error type is a single tagged union. All foreign errors (`io`, `toml`, `rusqlite`, `notify`, `tantivy`) collapse into `ChanError::Io`, `::ConfigDecode`, `::Graph`, `::Watch`, `::Search` with their `Display` text preserved.

Variants intentionally do not carry rich nested types: uniffi can encode an enum with primitive payloads; nested error chains do not round-trip cleanly across the FFI.

Notable variants:

  - `WorkspaceLocked`: another process holds the writer lock.
  - `WorkspaceAlreadyOpen`: this process still holds a handle.
  - `WriteConflict { current_mtime_ns }`: CAS write lost the race.
  - `TrashOccupied`: restore would clobber a live entry.
  - `SpecialFile { kind, path }`: target is a symlink, FIFO, socket, or device.
  - `WriteTooLarge { kind, size, limit }`: write exceeds `TEXT_WRITE_LIMIT` / the configured transfer ceiling.
  - `ListingTooLarge { observed, limit }`: listing exceeds `LIST_TREE_LIMIT` / `LIST_DIR_LIMIT`.
  - `NotEditableText`, `PathEscape`, `SymlinkEscape`: gate and sandbox refusals.
  - `DraftBroken { name, message }`: draft dir failed inspection.
  - `Cancelled`: a cancel flag stopped a reindex.

## 8. Schema versioning

  - **Graph DB**: `PRAGMA user_version`. Migrations are idempotent and applied on every `GraphView::open`. Current version: 6 (v2 added `basename`, v3 added `emails`, v4 added staging tables for resumable reindex, v5 added a `size` column on `nodes` + `staging_nodes` so `Workspace::reconcile` can detect same-mtime-different-content rewrites that a mtime-only diff would miss, v6 added `aliases` so the mention resolver can map `@@<alias>` to a contact without re-parsing frontmatter per query). Each `v < N` block wraps its schema change and the `PRAGMA user_version = N` bump in a single `unchecked_transaction` so a crash mid-migration leaves the DB at the previous version with intact data. A `column_exists` helper guards the `ALTER TABLE ADD COLUMN` calls so a crash before commit, which leaves the column physically added but `user_version` at the prior value, is safely re-run on the next open without `duplicate column name` errors.

  - **Reindex resumability** (v4 staging): `rebuild_graph` parses each file straight into `staging_nodes` / `staging_edges` / `staging_headings`. Each file's stage is its own committed transaction, so the parse cursor (`MAX(rel_path)` over `staging_nodes`) advances durably without holding a long-lived transaction. The atomic `swap_staging` at the end clears live tables and copies from staging in one transaction; readers (autocomplete, backlinks) see the previous live state until that single commit, then the new state. A crash mid-rebuild is detected at next open by the `rebuild.inprogress` marker plus a non-empty staging cursor; the resumed reindex calls `sanitize_staging` (purges staged rows for files deleted from disk between sessions) then walks files strictly greater than the cursor, so already-parsed files are not redone.
  - **Search index**: `IndexConfig.schema_version` is persisted alongside the embedding model id and chunking strategy. Current version: 3 (the indexer ingests every `FileClass::EditableText` extension, i.e. `.md` + `.txt`). Mismatched versions wipe index data and rebuild on next open. Model swaps force an embeddings rebuild because embedding dimensions and numerical drift differ.

  - **Vector shards**: each per-file file under `embeddings/` carries its own `FORMAT_VERSION` (currently 2; the format includes the `body_hash` checkpoint field for embed-phase skip on partial rebuilds). The version is checked per shard in `load_all`; a mismatch drops the shard silently and the next `build_all` re-embeds the file. This is intentionally independent of the schema-version wipe path: a shard-format bump should NOT invalidate BM25 segments or other shards, only the shards that actually need re-encoding.

  - **Report JSONL**: `chan-report`'s `SCHEMA_VERSION` (currently 1) is checked on load; a mismatch (or any parse error) makes chan-workspace discard the cache and rescan.

A schema bump in any store is user-data-safe: only chan-managed cache is destroyed; the user's notes are untouched.

## 9. Native-shell boundary

`chan-workspace`'s interface is shaped to survive a uniffi boundary: no lifetimes in exported data, owned strings/paths, `Arc`-able handles, one umbrella `ChanError` enum with primitive payloads, and callback-based streaming instead of Rust stream/channel types. A native shell links the same crate and shares the atomic-write / sandbox / blob-storage semantics with the desktop chan-server without reimplementing them per platform. The `--no-default-features` build (BM25-only, no candle) is the expected starting point for iOS until candle-core builds cleanly for that target.
