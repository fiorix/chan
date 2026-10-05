# A pick made before a board has adopted the scene is dropped

Status: shipped in [v0.102.0](../../release/release-v0.102.0.md).

Record before the release: accepted by the owner on 2026-10-04 for a build; raised for a decision on 2026-10-03 by the lead, from the build and the independent review of a queued push's repair ([a-background-the-authority-never-took-turns-back](a-background-the-authority-never-took-turns-back.md)). Read in the code and in the mounted suites; no browser ran.

## Owner ruling

Accepted for a build on 2026-10-04, as the lead recommended: a pick made on a board before its first adopt is kept as a claim, laid over the first snapshot and pushed; one order of its own with its own pins, ordered last among the drawing's rows, after the queued push's repair and the server's first frame.

## What was seen

With scene sync on, a board that binds before its socket's first snapshot, or that mounts while the socket is down, shows the buffer it was seeded from. A grid or a background picked there is offered at the board's flush and kept as no claim: the session keeps an offered appState as a claim only once the board has adopted (`keepsAppStateClaim`, `web/packages/workspace-app/src/state/sceneSync.svelte.ts`). The snapshot then replaces the pick, on the board and after it in the buffer. An element drawn in the same window survives, since an element has a version and a pick has none.

The rule that drops the pick is meant: an appState offered by a canvas that binds between two sockets is no claim. `web/packages/workspace-app/src/editor/design.md` states it and three cases pin it. So this is a choice and not a slip.

The window is short where the first frame of a drawing's socket is its snapshot. A server that sends a small frame first, so that a large drawing's first dial does not time out, makes it as long as the snapshot takes (inferred, not run).

## Desired contract

A pick the user made on a board is kept whichever scene it was made over: one made before the board's first adopt is laid over the first snapshot, shown, and pushed. Or the rule stays and its cost is written: such a pick reverts in front of the user, who picks again.

## What to do

If accepted: the session keeps the keys a board offers before its first adopt as a claim, lays them over the first snapshot and pushes them. The canvas offers only the keys changed against its seed, so the claim holds picks alone. It reverses the rule above and changes what an adopt keeps, so it is one order with its own pins, after the queued push's repair and the first frame are on the branch.

## Boundaries

No change to what an element's version decides. No change for a tab that is read-only or a session that has stopped: both drop an offer today and keep doing so.

## Acceptance

1. A background or a grid picked on a board before its session's first snapshot is on the board and in the buffer after the snapshot, and reaches the other windows; pinned red first in the session's suite and in a mounted case.
2. A pick made by another window, carried by that first snapshot, is kept for every key this window did not pick; pinned.
3. The three cases that pin today's rule are turned or kept with the reason said, and `web/packages/workspace-app/src/editor/design.md` says what the code does.

## What shipped

Built on 2026-10-04 on the v0.102.0 integration branch and not on `main`, in a range the lead accepted on its report, its status files and an independent review of its whole diff: the session keeps a claim from a pick made before its first snapshot (one clause of `keepsAppStateClaim`, `web/packages/workspace-app/src/state/sceneSync.svelte.ts`), lays it over that snapshot for the key the user picked and keeps the other window's value for the key they did not, and pushes it once the window has caught up; three pins that held the old rule were turned and one added, and `web/packages/workspace-app/src/editor/design.md` states the rule in six places. Acceptance 1 to 3 are met. Left, found while building and ruled the same day for the next build on the page: a background picked before Restore on a board that has adopted nothing comes back at the first snapshot over the entry's and the authority's; the host will tell the session at Restore, which ends the claim, as a reload does. The row stays at build until that lands.

The Restore case was closed on 2026-10-04, in a range the lead accepted on its report, its status files and an independent review of its whole diff: Restore on a drawing whose board has adopted no snapshot tells the session, which ends a grid or background claim picked on the board Restore replaced, as it ends one when the tab takes the disk's scene, so at the first snapshot the snapshot's values take the board and nothing of the pick is pushed (`web/packages/workspace-app/src/components/FileEditorTab.svelte`); a mounted case turned to pin it, red first, and `web/packages/workspace-app/src/editor/design.md` says so. Restore on a live board is unchanged. The session's method that Restore now calls is still named and documented for a conflict's resolution alone (`web/packages/workspace-app/src/state/sceneSync.svelte.ts`); renaming it or widening its doc was left for a ruling. This row is complete.

The method was renamed on 2026-10-04, in a range the lead accepted on its report, its status files and an independent review of its whole diff: the session's `tabTookDisk()` is `endAppStateClaim()`, documented for a conflict's resolution and for Restore on a board with no adopted live scene, while the registry's `tookDisk` hook keeps its name for the event it reports (`web/packages/workspace-app/src/state/sceneSync.svelte.ts`, `web/packages/workspace-app/src/components/FileEditorTab.svelte`); nothing it does changed, and `web/packages/workspace-app/src/editor/design.md` now counts six ways a claim ends, Restore among them.
