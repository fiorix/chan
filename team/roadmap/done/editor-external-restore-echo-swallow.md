# Editor serves stale content after an external restore (echo-ring swallow)

> Status: shipped in [v0.76.0](../../release/release-v0.76.0.md): the echo ring parks an unmatched external-restore observation and re-checks after the ring TTL instead of clearing it (mirrored in scene_sessions); browser smoke check 57 is ungated.
>
> Superseded by [editor-filesystem-edit-convergence](editor-filesystem-edit-convergence.md) in [v0.78.0](../../release/release-v0.78.0.md). The fix recorded here converted permanent staleness into a bounded 60s window and accepted that window; v0.78.0 removed it by giving ring entries an origin, so read bytes no longer inherit the protection meant for written bytes.

Status: REGISTERED for v0.76.0. Root-caused and reproduced; the fix
is scoped below. Found during the v0.76.0 external-edit reliability
hunt (guards landed in `scripts/e2e/browser-smoke/checks/55,56`; the
repro is `checks/57-external-restore-converge.mjs`).

## Problem

A doc session's `DiskEchoRing` (introduced v0.68.0, `5c1b1509`, for
lying FUSE echoes) swallows an external edit that byte-exactly
restores content the session put on disk within the last 60s (attach
seed, flush, or merge). The swallow clears `pending_fold` and adopts
the token, and because the reconciler is event-driven, nothing
re-checks the file after the ring's 60s TTL lapses: the stale
authority is served permanently -- to the open tab, to fresh tabs,
and to `GET /api/files` (the session divert), so every later
`cs open` shows the old version while the indexer correctly reindexes
the real disk bytes (editor and search index disagree).

Reproduced end to end (check 57; `SMOKE_RUN_REPRO=1` to run, red by
design): open V1, external edit to V2 (folds live), external restore
of V1 -> editor and API keep serving V2; a later V3 edit folds fine,
proving the session was alive and the restore was specifically
misclassified. A `SMOKE_TTL_WAIT=1` probe proves the staleness
outlives the ring TTL. `scene_sessions` mirrors the same machinery
(`crates/chan-server/src/scene_sessions/mod.rs:992`).

## Fix direction

In the echo branch (`doc_sessions/mod.rs:1156`), park the observation
instead of clearing it: keep a pending re-check (hash + mtime +
deadline at ring-TTL lapse) that `reconcile_pending` re-reads after
the echo entries expire, and fold when disk still disagrees with the
authority. Mirror in `scene_sessions`. Existing echo tests
(`reconcile_ignores_own_flush_echo`, `stale_prewrite_read...`) must
keep passing; add a restore-after-TTL unit test.

## Acceptance

- Check 57 ungated and green in the default browser-smoke run.
- Rust unit test: external restore of ringed content folds once the
  ring entries expire; honest flush echoes still never fold.
- Scene-session equivalent covered.
