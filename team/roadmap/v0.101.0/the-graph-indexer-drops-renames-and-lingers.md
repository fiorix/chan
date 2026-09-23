# The graph indexer drops a rename's destination and outlives its drop

Status: raised during v0.100.0 on 2026-09-23; not accepted. From the release report's Rust-lows follow-up (worklist L78 and L84, the `GraphIndexer` findings). A source reading against `main` at `6237c2677`.

## What was seen

`apply_event` (`crates/chan-workspace/src/indexer.rs:287`, `Renamed` arm at `:339`) forgets a single-path rename's `path` without checking whether it still exists, so the destination drops out of the graph (L78). `impl Drop for GraphIndexer` (`:166`) stops the worker only when it holds the last strong reference, but the worker thread holds a second `Arc`, so dropping the indexer never stops it (L84, latent: the drop comment treats the indexer as a singleton that chan-server holds); `stop` (`:151`) works only when called.

## What to do

Re-check existence on a single-path rename and index the destination, and give the worker a weak reference or an explicit shutdown handle so a drop stops it, each with a test shown red first. The owner decides whether `GraphIndexer` keeps its clone-and-drop model at all.
