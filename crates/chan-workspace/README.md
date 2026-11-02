# chan-workspace

The core of chan's workspace layer: a sandboxed filesystem over any directory, the per-machine workspace registry, and the state chan derives from a workspace (search index, link graph, code report, trash, drafts) kept under the chan home, never inside the directory. Every read and write of user content in chan goes through one of this crate's facades.

## Add to your project

Inside this repository the crate is a workspace dependency:

```toml
[dependencies]
chan-workspace = { workspace = true }
```

The `embeddings` feature (on by default) adds dense vectors beside BM25 for hybrid search and pulls the candle stack; `--no-default-features` builds BM25-only.

## Public API at a glance

- `Library`: per-machine handle. Owns the registry in `~/.chan/config.toml` (or `config.toml` under the directory `CHAN_HOME` names), resolves the chan home, and opens workspaces.
- `Workspace`: one registered directory. Holds the cross-process writer lock for its lifetime.
  - Filesystem: `read`, `read_text`, `write_text`, `write_bytes`, `read_text_with_stat` plus `write_text_if_unchanged` (mtime compare-and-swap), `stat`, `list`, `list_tree`, `create_dir`, `rename`, `copy`, `remove` (soft delete to the trash).
  - Trash: `trash_list`, `trash_restore`, `trash_purge`, `trash_empty`; 30-day retention, lazy collection.
  - Search and graph: `search`, `workspace_search`, `reindex`, `index_file`, `forget_file`, `link_targets`, `resolve_link`; `graph()` returns a `GraphView` (`neighbors`, `backlinks`, `tags`, `files_with_tag`, `headings_of`, `contacts`).
  - Watch and report: `watch(Arc<dyn WatchCallback>)` returns a `WatchHandle`; `report()` and `report_for_prefix` return the code report.
  - Drafts and sessions: `create_draft`, `list_drafts`, `promote_draft`, `discard_draft`; `put_session` and friends store opaque host JSON.
- `MiniWorkspace`: the metadata-free facade behind the standalone Files window. It registers nothing, takes no lock, and starts no index or graph.
- `SidecarStore`: chan's own per-workspace records (editor recovery) through the same sandboxed reader and writer, outside the user tree.
- `DraftStore`: draft lifecycle for standalone windows and workspace sidecars.
- `ChanError`: the facades' umbrella error enum, with string, path and integer payloads.

The API is synchronous: no `async fn` and no async runtime, so callers drive it from threads they own. `Library` is a cheap clone, `Workspace` is shared as `Arc<Workspace>`, and watch and progress events are owned, serializable values delivered through callback traits.

## Path and link conventions

Every API path is workspace-rooted POSIX with no leading slash and no `..`; the sandbox rejects anything else. Inside Markdown bodies, hrefs stay in the form the renderer expects (relative to the file that contains the link, as on GitHub), and `markdown::normalize_href` maps each to the same workspace-rooted destination for the graph without rewriting the text on disk. The same normalizer is ported to TypeScript so the editor's click handler agrees with the indexer. See [design.md](design.md) for the resolution rules and the wiki-link variant.

## Build and test

From the repository root:

```bash
cargo build -p chan-workspace
cargo test -p chan-workspace
cargo fmt --check
cargo clippy --all-targets -- -D warnings
```

The Rust toolchain is pinned in `rust-toolchain.toml`. The `embeddings` feature pulls candle, tokenizers and hf-hub, which are heavy first-build dependencies; `--no-default-features` skips them.

## Design reference

See [design.md](design.md) for the facades, the sandbox and atomic-write rules, state placement under the chan home, the locking model, the watcher, the index and graph, recovery, schema versioning and the error model.

## License

Apache-2.0. See [`../../LICENSE`](../../LICENSE).
