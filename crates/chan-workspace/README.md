# chan-workspace

Sandboxed filesystem, full-text search, link-graph, and report primitives for chan. A registered workspace can be any directory; its reads and writes go through a strict path sandbox, every write is atomic, and a tantivy index plus a sqlite link graph sit alongside the file tree without writing anything inside it. The same filesystem-capability core also serves standalone Files windows without registering a workspace or starting its metadata services.

## Add to your project

```toml
[dependencies]
chan-workspace = "0.11"
```

Hybrid (BM25 + dense) search is on by default via the `embeddings` feature. Disable with `default-features = false` for a BM25-only build (iOS, minimal targets).

## Public API at a glance

  - `Library`: per-machine handle. Owns the workspace registry at `~/.chan/config.toml` (or the platform sandbox equivalent), resolves OS state and cache paths, opens workspaces.
  - `Workspace`: per-directory handle. Holds a cross-process writer lock for its lifetime.
    - Filesystem: `read`, `read_text`, `write_text`, `write_bytes`, `read_text_with_stat` + `write_text_if_unchanged` (mtime CAS), `stat`, `list`, `list_tree`, `create_dir`, `rename`, `remove` (soft-delete to trash).
    - Trash: `trash_list`, `trash_restore`, `trash_purge`, `trash_empty`. 30-day retention, lazy GC.
    - Search: `search`, `reindex` (sync), `index_file`, `forget_file`, `link_targets`, `resolve_link`.
    - Graph: `graph()` returns a `GraphView` with `neighbors`, `backlinks`, `tags`, `files_with_tag`, `replace_file`.
    - Watch: `watch(Arc<dyn WatchCallback>)` returns a `WatchHandle`; drop to stop.
    - Blob storage: `put_session` and friends for opaque host JSON (window/session state).
  - `MiniWorkspace`: metadata-free filesystem facade for the standalone Files surface. It registers nothing, takes no writer lock, and starts no index or graph.
  - `ChanError`: one umbrella enum, primitive payloads, FFI-safe.

All public types are owned (no lifetimes), `Send + Sync`, and shaped for a future uniffi binding to Swift / Kotlin shells. No public `async fn`; async runs internal to the crate where it exists at all.

## Path and link conventions

Two path forms coexist on purpose:

  - **API surface** (every `Workspace` method, MCP tool `path` args, graph row keys) takes one canonical form: a workspace-rooted POSIX rel path with no leading slash and no `..`. The path sandbox rejects anything else.
  - **Inside markdown bodies**, hrefs stay in whatever form the renderer expects. The GitHub convention is "relative to the file that contains the link" (`./bar`, `../images/x.png`), which keeps notes rendering correctly when viewed outside chan (GitHub web, Obsidian, a pasted preview).

`markdown::normalize_href(href, source_dir)` bridges the two: it accepts `./foo`, `../bar`, `/baz`, or bare `foo` and resolves each to the same workspace-rooted destination for the graph. The on-disk text is never rewritten. The same normalizer ships as a hand-port to TypeScript so the editor's click handler agrees with the indexer on what each link resolves to. See `design.md` for the full resolution rules and the wiki-link (`[[name]]`) variant.

## Build and test

From the workspace root:

```bash
cargo build
cargo test
cargo fmt --check
cargo clippy --all-targets -- -D warnings
```

The Rust toolchain is pinned in `rust-toolchain.toml`. The `embeddings` feature pulls candle + tokenizers + hf-hub, which are heavy first-build dependencies; `--no-default-features` skips them.

## Design reference

See [design.md](design.md) for the on-disk layout, locking model, sandbox invariants, error model, schema versioning, and consumers.

## License

Apache-2.0. See [`../../LICENSE`](../../LICENSE).
