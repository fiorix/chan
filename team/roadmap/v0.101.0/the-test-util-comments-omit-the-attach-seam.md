# The test-util comments do not name the attach seam

Status: accepted for v0.101.0 by the owner on 2026-09-24; raised during v0.100.0 on 2026-09-23. From the Lead follow-ups ledger (2026-09-22 20:52Z, SecondWorker order 1 report). A source reading against `main` at `6237c2677`.

## What was seen

The `test-util` feature exposes chan-library's attach seam to tests: `AttachSeam` (`crates/chan-library/src/terminal_sessions.rs:948`), `arm_attach_seam` (`:971`) and `Registry::inject_output` (`:1952`). The comments that justify the feature do not mention them. `crates/chan-library/Cargo.toml:14-18` describes the feature as the registry helpers chan-server's tests drive, and `crates/chan-server/Cargo.toml:92-95` names only the `attach`, `len` and `is_empty` helpers, so a reader deciding whether the feature can go learns nothing about the seam the attach tests depend on.

## What to do

Name the seam and the output injector in both comments, in the same commit as any later change to either crate's manifest.
