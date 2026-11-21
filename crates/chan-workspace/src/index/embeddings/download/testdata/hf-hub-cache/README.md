# A cache in hf-hub's layout

These files describe a model cache as hf-hub 0.4.3 wrote it, the layout chan's downloader wrote before it pinned each model: every file is a blob under `blobs/` named by its sha256, beside an empty lock file, and `snapshots/<commit>/<file>` is a relative link to it. The three payloads are small and are not a model that loads.

- `fixture.json` names the model and commit, and each file's payload, sha256 and size.
- `layout.jsonl` lists the cache's entries sorted by path: directories, files with their size and sha256, and links with their target text.
- `refs-main.bin` holds `refs/main`: the forty commit bytes, no newline.
- `payloads/` holds the three files' bytes.

`cache_layout_tests.rs` rebuilds this cache in a temporary directory and opens each file through chan's downloader pinned at another commit, so the files come through `refs/main` with no request and no change to any entry. The test is Unix-only because the cache holds symlinks.
