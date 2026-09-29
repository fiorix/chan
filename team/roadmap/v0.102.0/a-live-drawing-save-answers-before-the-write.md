# A save of a live drawing answers before the authority writes the file

Status: accepted by the owner on 2026-09-29 for a later version than v0.101.0, so it is held under v0.102.0; raised during v0.101.0 on 2026-09-29 by the independent review of the live drawing's fix round, which landed that day with [a-live-drawing-gains-appstate-keys-with-no-edit](../v0.101.0/a-live-drawing-gains-appstate-keys-with-no-edit.md) (`dev/v0101-team/reviews/review-Frontend-17.md` in the development tree, its finding 8, with the lead's notes, which raise it at the landing as an item of its own and give no recommendation). The review read it on the client and the server and ran nothing, and found it older than v0.100.0 and outside the ranges it reviewed. Read again at `e2a7e608f` and at `v0.100.0`; not run.

## Owner ruling

Accepted on 2026-09-29 for a later version. The owner accepted in one answer every recommendation the lead had put to them that day, and with that answer closed v0.101.0's intake under one rule: a raised item enters v0.101.0 only when it loses a user's data or weakens security and its fix is small and local, a test-only or infrastructure item only when it makes the release gate or a release job unreliable, and an item whose fix changes a contract or reopens excluded scope, or whose fault is a wrong state with a rare trigger, goes to v0.102.0. Under that rule this item goes to v0.102.0: its fix changes the wire, the frame that answers a push, and the file takes the change within the authority's debounce, so nothing is lost unless the server stops inside it. When it was raised the lead recommended a later version, and v0.101.0 only if a server that stops inside the debounce is read as a way to lose a drawing. It is not part of v0.101.0.

## What was seen

Lines at `e2a7e608f`, under `web/packages/workspace-app/src/` where no other path is named. The scene session's save waits until nothing of this window's is on the wire, queued or not yet handed over, and the authority reports itself clean (`checkFlushWaiters`, `state/sceneSync.svelte.ts:977-997`). It learns whether the authority is clean only from a snapshot, an update or a flush frame (`:869`, `:900`, `:921`); the push-ok arm leaves that as it was (`:774-781`), and a push-ok carries a version alone (`crates/chan-server/src/routes/scene.rs:126`). The authority applies a push, fans it to the other windows alone, marks itself dirty and answers the sender with a push-ok (`crates/chan-server/src/scene_sessions/mod.rs:1157-1170`), and writes the file once it has been dirty for 800 ms (`SCENE_FLUSH_DEBOUNCE`, `mod.rs:71`; `flush_pass`, `:1426-1447`). So after this window's own push on an authority that was clean, a save that waits on that push answers saved at its push-ok, before the file holds it, and the force-reload prompt's question for unflushed state reads none (`hasUnflushedState`, `state/sceneSync.svelte.ts:400-403`). A mounted pin ends a save at a push-ok with no flush frame (`components/FileEditorTab.canvasEdits.test.ts:903`).

Between the push and the write, the push marks the session's recovery record as pending (`mod.rs:1165`), and the flusher, which wakes every 200 ms (`FLUSH_TICK`, `mod.rs:81`), stores that record for a session that is not yet due to be written (`:1443-1444`; `persist_pending_recovery`, `:576-588`); what a restart does with the record was not read when the item was raised. Read at `4c4ada0a1` on 2026-09-29, where the server's scene sessions are as they were: the next attach loads the stored record and builds the authority from it (`mod.rs:1297-1313`, `:1371-1375`; `from_recovery`, `:351-522`), so a change that was pushed is lost only when the server dies before the flusher's tick has stored its record. Read, not run.

The same at `v0.100.0`: its push-ok arm leaves the authority's dirty flag alone (`git show v0.100.0:web/packages/workspace-app/src/state/sceneSync.svelte.ts`, `:718-727`), which only a snapshot, an update and a flush frame write (`:791`, `:817`, `:838`).

## Desired contract

A save of a live drawing answers saved only once the file holds the changes it waited on.

## What to do

As suggestions: the push-ok says whether the push changed the authority's scene, and a session whose push did treats the authority as dirty until the next flush frame. A push-ok alone cannot stand for a dirty authority, since the server acks a push that changed nothing and writes nothing after it (`mod.rs:1160-1170`), and a save would then wait out its four seconds and fall back to the classic write. Red first: a session test in which a push on a clean authority is acked, and a save that waits on it answers only after a flush frame; today it answers at the push-ok.

## Boundaries

`web/packages/workspace-app/src/state/sceneSync.svelte.ts` (the push-ok arm, `checkFlushWaiters`) and its tests, and, if the push-ok carries more, `crates/chan-server/src/routes/scene.rs` (`ServerFrame::PushOk` and its pin) and `crates/chan-server/src/scene_sessions/mod.rs` (`push`).

## Acceptance

1. A save that waits on this window's own push answers after the authority's flush frame; pinned red first.
2. A push that changed nothing still lets a waiting save answer at once.
3. The force-reload prompt reads the authority's unwritten push as unflushed state.
