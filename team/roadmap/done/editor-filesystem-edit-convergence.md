# External filesystem edits converge in the editor (echo-ring origin split)

> Status: shipped in [v0.78.0](../../release/release-v0.78.0.md): disk-echo ring entries carry an origin, so bytes the session merely READ from disk no longer earn the 60s protection meant for bytes it WROTE. An external edit restoring previously-seen content reaches the editor in 28ms rather than 58.6s, and a truncation in 407ms rather than not at all.

This closes the root cause behind [editor-external-restore-echo-swallow](editor-external-restore-echo-swallow.md), which shipped a partial fix in v0.76.0. That fix converted permanent staleness into a bounded 60s window and accepted the window; this one removes it.

## Problem

A doc or scene session keeps a ring of content hashes so a filesystem that commits asynchronously cannot make the session's own flush echo look like an external edit. Entries did not record where they came from, so bytes the session merely read from disk earned the same 60s protection as bytes it wrote. An external edit returning a file to content the session had already seen was classified as an echo and held back from the editor.

That is the shape of every undo, revert, and `git checkout`, and the shape agents produce when they edit files through the filesystem rather than through the MCP server. Additions were unaffected, because they almost always produce content the session has never seen, so the failure presented as "removals never reach the editor" even though a deletion producing novel content converged immediately.

## Fix

Ring entries carry an origin. `Written` bytes keep the full 60s window, because an upload queue really can replay them under a re-stamped mtime. `Adopted` bytes get 1500ms, which covers a stale read racing the watcher event that announced them and nothing beyond that. The empty-read refusal now requires a recent write of the session's own to blame, so truncating a file the session never wrote converges after the ordinary corroboration delay instead of waiting out the ring.

The written-versus-adopted asymmetry is deliberate, not an oversight: the two origins have genuinely different risk, and scenario WL-15 records that reasoning so a later reader does not "simplify" them back together.

Implementation: `crates/chan-server/src/disk_echo.rs`, `doc_sessions/mod.rs`, and the `scene_sessions/mod.rs` mirror.

## Why the class survived a release

The browser-smoke suite had never shrunk a file in any check. Every external-edit check added content or replaced it with novel content, both of which converged correctly. The bug lived precisely in the untested direction.

Check `57` previously asserted the old deferral and budgeted 75s for it; it now asserts prompt convergence. New check `63` covers partial shrink, restore of prior bytes, rapid add and remove cycles, truncation to empty, and refill.

## Validation

905 chan-server tests single-threaded, fmt and clippy clean, and the editor, collaboration, and external-edit browser checks green. Both new unit tests and both new browser checks were confirmed to fail when the origin split is removed, and to fail only on the restore, cycle, and truncate steps.

## Known gaps carried forward

The full browser-smoke suite is contention-sensitive on an 8-core host, and a different incidental check reds on each full run, including on a build with this fix removed. Check `62` asserts upload progress coalescing with no slack against its 10 Hz bound, and check `60` hard-fails where its sibling `95` skips when the launcher bundle is absent. Neither is addressed here; both are recorded as follow-ups in the release report.
