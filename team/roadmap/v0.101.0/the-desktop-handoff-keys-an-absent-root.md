# The desktop handoff keys an absent root before it creates it

Status: raised during v0.101.0 on 2026-09-26 by the independent review of a test-only order (`dev/v0101-team/reviews/review-Services-1.md`, finding 4, in the development tree), which found it older than that order's range and unreachable from shipped senders. A source reading against `main` at `1566b06d0`; not reproduced.

## What was seen

The desktop's CLI handoff computes `canonical_key(&path)` for the requested root (`desktop/src-tauri/src/main.rs:2889`) before `register_workspace_path` may create the directory (`main.rs:1124-1125`). For a path that does not exist at arrival, the key is the lexical fallback (`crates/chan-workspace/src/paths.rs:431`), and `serve::start` mints the window record with that spelling (`desktop/src-tauri/src/serve.rs:112`). Since the feed matches records lexically against the runtime's stored keys (`crates/chan-library/src/host.rs:2103`), such a record is hidden and the desktop opens nothing. Before that change the feed canonicalized each record at read time, so the record resolved once the directory existed. The shipped CLI creates the root (`crates/chan/src/lib.rs:3927`) before it hands off (`:3944`), so only a race between the two or a client that does not create the root reaches this.

## Desired contract

A handoff for a root the desktop creates keys the root after it exists, so the record it mints is the spelling the feed matches.

## What to do

Compute the key after `register_workspace_path` has created the directory, or key the record from the registry row that call returns. Red first: a desktop or host-level test that hands off an absent path and asserts the minted record is in the feed once the workspace is mounted; today it is hidden.

## Boundaries

`desktop/src-tauri/src/main.rs` (the CLI handoff) and `serve.rs`; nothing in the feed match or the root locks.
