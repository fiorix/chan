# chan-report

Per-file language and SLOC report for a directory tree, with per-language roll-ups and a Basic COCOMO summary on top. Maintains state incrementally so a single filesystem event re-counts one file instead of the whole tree.

Built to be embedded in `chan-workspace`. The crate is I/O-free for state: it walks, counts, and computes; persistence is the consumer's responsibility. chan-workspace atomically writes the JSONL to `workspaces/<metadata_key>/report/report.jsonl` under the chan home (`~/.chan` by default).

## Public API at a glance

```rust
use chan_report::{Index, ReportOptions, Scope, CocomoParams};

// Initial scan.
let opts = ReportOptions::new("/path/to/workspace");
let mut idx = Index::scan(&opts)?;

// Incremental updates from a watcher.
idx.update("notes/today.md")?;
idx.remove("notes/old.md");
idx.rename("notes/a.md", "notes/b.md")?;

// Snapshot the whole tree, a subtree, or a specific set of files.
let _ = idx.snapshot(&Scope::All, &CocomoParams::default());
let _ = idx.snapshot(&Scope::Prefix("crates/".into()), &CocomoParams::default());
let _ = idx.snapshot(
    &Scope::Files(vec!["src/lib.rs".into()]),
    &CocomoParams::default(),
);

// Stream to JSONL (callers atomic-write the resulting bytes).
let mut buf = Vec::new();
idx.write_jsonl(&mut buf, &Scope::All, &CocomoParams::default())?;
```

## Build

```bash
cargo build -p chan-report
cargo test  -p chan-report
```

## See also

- `design.md` for the on-disk JSONL schema, walker rules, COCOMO formula, and the invariants the incremental code preserves.
