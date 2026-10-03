# A save's fallback can write the buffer of a live drawing whose board never seeded over a peer's edit

Status: accepted by the owner on 2026-09-29 for a later version than v0.101.0, so it is held under v0.102.0; raised during v0.101.0 on 2026-09-29 by the report of the frames around a live board's init, which landed that day with [a-scene-snapshot-before-the-init-is-wiped](../done/a-scene-snapshot-before-the-init-is-wiped.md) (`dev/v0101-team/reports/report-Frontend-29.md` in the development tree, "Residuals"). The builder found it answering a ruling of the lead's (`dev/v0101-team/followups/followup-Frontend-Lead-17.md`), and the lead ruled it written as a cost and raised for the owner, not built, since a delegate that refuses the fallback changes what a failed save answers a user (`dev/v0101-team/followups/followup-Lead-Frontend-21.md`, rulings 3 and 4). The review of that range read the server's write and found a second way into the state (`dev/v0101-team/reviews/review-Frontend-16.md`, finding 7). Read again at `e2a7e608f` in the app and the server; not run, and not reproduced. Older than that build: the builder read the same path at the range's base. Ruled on 2026-10-03: see Owner ruling.

## Owner ruling

Accepted on 2026-09-29 for a later version. The owner accepted in one answer every recommendation the lead had put to them that day, and with that answer closed v0.101.0's intake under one rule: a raised item enters v0.101.0 only when it loses a user's data or weakens security and its fix is small and local, a test-only or infrastructure item only when it makes the release gate or a release job unreliable, and an item whose fix changes a contract or reopens excluded scope, or whose fault is a wrong state with a rare trigger, goes to v0.102.0. Under that rule this item goes to v0.102.0: the loss is latent, since no production caller saves a clean tab, so no caller reaches the path (the reading of 2026-09-29 below), and a guard changes what a failed save answers a user. The shape is not ruled, and it is the owner's: the save refuses the fallback while its session has no binding, or the item is kept as latent. When it was raised the lead recommended accepting it for v0.101.0, since a peer's edit can be deleted. It is not part of v0.101.0.

On 2026-10-03 the owner ruled, as the lead recommended: the save refuses the fallback while its session has no binding, and says the drawing was not saved.

## What was seen

Lines at `e2a7e608f`, under `web/packages/workspace-app/src/` where no other path is named. A live drawing's tab can hold a scene session with no seeded board, in two ways:

- **A board whose library never reports its init's change** never seeds (`seed`, `editor/ExcalidrawCanvas.svelte:433-452`, reached from `onLibraryChange`, `:461-465`). The stand-in reads the library as reporting a change after every init (`src/__tests__/excalidrawLibrary.ts:18-19`), and the builder knew of no way to reach it by hand.
- **A restored drawing tab that was never brought to the front** has a session and no canvas: the host imports the canvas at the tab's first showing (`components/FileEditorTab.svelte:184-190`) and acquires the session whether or not the tab is shown (`:404-417`), as the review read it; that a pane keeps the hosts of tabs not shown mounted rests on the host's comment (`:174-178`).

Neither binds (`editor/ExcalidrawCanvas.svelte:384-389`), pushes (`:281`) or publishes (`:487`), so the tab's buffer stays the load's text.

An explicit save of such a tab asks its session to flush (the save delegate, `state/sceneSync.svelte.ts:1098-1105`; `flush`, `:546-560`). With no binding and nothing claimed, the session reads everything local as confirmed (`allLocalConfirmed`, `:972-975`) and answers saved once the authority reports itself clean, writing nothing (`checkFlushWaiters`, `:977-997`). When the flush fails instead, by its four-second timer (`:552-555`) or a flush error frame (`onFlush`, `:909-919`), the session degrades (`:1103`), and the save falls through to the classic write of the buffer (`performSaveOnce`, `state/tabs.svelte.ts:5885-5893`, the write at `:5933`), which a degraded session whose socket is open does not pause (`isOutagePaused`, `state/sceneSync.svelte.ts:382-386`; `state/tabs.svelte.ts:5909`). That write carries the tokens of the session's last frames, the version of every frame (`state/sceneSync.svelte.ts:775`, `:844`, `:891`) and the mtime of every flush frame (`stampMtime`, `:941-949`), while the buffer is as old as the load.

The server sends a write of a path with a live scene session into the session (`crates/chan-server/src/routes/files.rs:2053-2071`, `:2214`), which takes it when those tokens are its own (`apply_http_replace`, `crates/chan-server/src/scene_sessions/mod.rs:713-744`; `check_write_preconditions`, `crates/chan-server/src/self_writes.rs:79-111`) and refuses it only while a conflict stands (`mod.rs:719-721`). Its replace makes a deletion of every live element that the text lacks and fans the result to every window (`apply_replace_with_limit`, `crates/chan-server/src/scene_sessions/scene.rs:420-431`; `apply_replace_locked`, `mod.rs:747-757`). So a peer's element drawn after this tab's load is deleted everywhere. Read, not run.

It needs three things at once: a tab in one of the two states, a flush that fails other than by a conflict, and an explicit save of that tab, which autosave and a close do not make, since the tab is never dirty (`isDirty`, `state/tabs.svelte.ts:5574-5578`). Whether a save can reach a restored tab that was never shown was not traced.

**Read again at `4c4ada0a1` on 2026-09-29,** on the integration branch; lines under `web/packages/workspace-app/src/`, searched under `web/packages` only, read and not run. The path is intact: with no binding and nothing claimed, the save's delegate degrades its session, `awaitPushSettled` answers settled, and `fallbackSettlement` answers settled once the session no longer owns saves (`state/sceneSync.svelte.ts:1253-1263`, `:601-622`), so the classic write runs (`state/tabs.svelte.ts:5973` onward). Two commits of the integration withhold the fallback, `5848f628a` and `567ce3a57`, and only while a push is unresolved, which a session with nothing claimed has none of; `editor/design.md:94` still names the cost. No production caller saves a clean tab: `saveTab` (`state/tabs.svelte.ts:8018`) has no caller outside tests, `app.save` is absent on purpose (`App.svelte:1450`), and every other caller of `performSave` is guarded by `isDirty`, except the conflict dialog's overwrite, which follows an earlier save. So no caller reaches the path as read; `saveTab` is exported, and a later caller would arm it.

## Desired contract

A save of a live drawing whose board has not seeded never writes the tab's buffer over the live scene: it writes nothing and says why, or writes only what the authority holds.

## What to do

The shape is a question for the owner, as the lead ruled: a delegate that refuses the classic fallback while its canvas tab has a session and no binding changes what a failed save answers a user. As suggestions: the scene session's save refuses the fallback in that state and says that the drawing was not saved; or the fallback writes what the authority holds rather than the buffer. Red first: a session test with no binding, a flush that fails by a flush error frame, and an explicit save, asserting no write of the buffer; today the buffer is written.

## Boundaries

`web/packages/workspace-app/src/state/sceneSync.svelte.ts` (the scene session's save delegate) or `src/state/tabs.svelte.ts` (`performSaveOnce`), with their tests. The server's write divert is unchanged.

## Acceptance

1. A save of a live drawing tab whose board never seeded, with its session's flush failing, writes nothing over the live scene; pinned red first.
2. The save says what it did.

## What shipped

Built on 2026-10-03 on the v0.102.0 integration branch and not on `main`, in a range the lead accepted on its report, its status files and an independent review of its whole diff. This record was written that day from those. No browser was driven.

A save refuses its fallback while the session has no bound canvas (`refusesFallback`, `web/packages/workspace-app/src/state/sceneSync.svelte.ts`; the session's save delegate answers `refused` and `performSaveOnce` returns on it): with no board seeded and nothing of this window's unresolved, a save whose flush fails writes nothing, says on the save line that the file was not saved, and leaves the session owning saves. The refusal is in the delegate and not in the save itself, since only the session knows whether a canvas is bound, and by answering before it degrades it leaves no degraded session whose later saves would reach the classic write. Built in part, and the row stays open. Read in the code by an independent review and by the lead, not run: the refusal asks only whether a canvas is bound, not whether the session still owns saves or is still alive. So when the session stops owning saves during the flush's wait (its grace ran out, a permanent error, a closed frame), this save is refused and the next one takes the classic write with the buffer the row exists to protect; and a session destroyed during the wait (a switch to Source, a rename, a reload) leaves the refusal's sentence on a tab whose board may be open, with no flush frame to clear it. The repair is ordered. Kept as built, by the lead's reading of the ruling: a session with no canvas and a push of this window's unresolved takes the existing path (the fallback withheld unless the push is acknowledged inside the settle wait, then the classic write with the buffer the canvas last mirrored), since a board had seeded there.
