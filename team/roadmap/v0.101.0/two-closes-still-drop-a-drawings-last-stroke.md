# A pane close from the control client, and a window's close, can still drop a drawing's last stroke

Status: accepted for v0.101.0 by the owner on 2026-09-27; raised for a decision on 2026-09-27 by the independent review of the fix that keeps a drawing's last stroke ([the-frontend-review-remainder-has-no-owner](the-frontend-review-remainder-has-no-owner.md); `dev/v0101-team/reviews/review-Frontend-10.md` in the development tree, finding 3), which read the code at `3dc581d3b`; read again in code at `b1ef073ae`, where both hold, and not reproduced.

## Owner ruling

Accepted on 2026-09-27 for v0.101.0, as the lead recommended. The owner accepted in one answer every recommendation the lead had put to them that day; for this item it was to accept it for this version, built after the drawing's orders then in hand.

## What was seen

A drawing's canvas serializes a change 200 ms after it (`web/packages/workspace-app/src/editor/ExcalidrawCanvas.svelte:308-311`), and every close the file tabs run now flushes that pending serialize before it reads the buffer (`pendingEditFlushes` in `src/state/tabs.svelte.ts:2620-2628`, run at `:2861`, `:3524`, `:6881` and `:7314`). Two ways to close still skip it.

- **`cs pane close`, `close_pane` and `close_all` without `--force`.** The control client's pane commands decide whether a tab blocks the close from its buffer against its saved content (`paneCloseBlock`, `src/state/store.svelte.ts:1361-1371`, asked at `:1526` and through `collectBlocks` at `:1538`, `:1546` and `:1564-1574`) before anything flushes, and then close by force (`:1531`, `:1541`, `:1554`), which skips the close-path flush (`tabs.svelte.ts:2854`, `:3524`). A stroke still inside the debounce is not yet in the buffer, so the tab reads as clean and is not reported as blocked, and, as the review reads it, the canvas's teardown flush then writes the stroke into a tab already removed. Had the flush run first, the command would have reported unsaved changes.
- **A window's close or reload.** It runs no close path: the close command discards the window's session and asks the desktop to close the window (`app.window.close`, `src/App.svelte:1419-1423`), and the unload handler writes only the editors' pending recovery buffers and the layout (`onUnloadFlushBuffers`, `:1513-1520`; `flushPendingBufferWrites`, `src/state/editorBuffer.ts:143-156`), which do not hold the canvas's pending serialize. A hide keeps the page and loses nothing. This was so before the fix.

## Desired contract

A stroke drawn just before any close, the control client's and a window's included, is saved or reported as unsaved, as it is for the file tabs' own closes.

## What to do

Run the pending-edit flush for each tab `paneCloseBlock` is about to ask, before it asks, so that an unforced pane close reports the stroke as unsaved. For a window's close and reload, flush every pending edit before the window's session is discarded, and synchronously in the unload handler, so the stroke reaches the tab's buffer before the page goes; how a drawing's buffer is then saved or recovered after a reload was not read, and is part of the work. Decide whether the window's close then asks about unsaved drawings, as a tab close does. Red first: `close_pane` without `--force` on a drawing whose last stroke is in the debounce reports nothing blocked.

## Boundaries

`web/packages/workspace-app/src/state/store.svelte.ts` (`applyPaneExec`, `paneCloseBlock`), `src/App.svelte` (the window's close command and the unload handler), and `src/state/tabs.svelte.ts` (a way to run every registered flush), with their tests. The file tabs' own closes are unchanged.

## Acceptance

1. `cs pane close`, `close_pane` and `close_all` without `--force` on a drawing whose last stroke is inside the debounce report the tab blocked with unsaved changes; with `--force` they close as they do now. Pinned by mounted tests.
2. A window's close or reload with a stroke inside the debounce leaves the stroke where the next open of the drawing finds it, pinned by a mounted test.

## What shipped

The build landed on 2026-09-29, and the item stays accepted until the readings on a display that its second point owes are taken at rc0. Lines at `e07f3862f`, under `web/packages/workspace-app/src/` where no other path is named. It came as a range (`dev/v0101-team/reports/report-Frontend-31.md` in the development tree, to the order `dev/v0101-team/tasks/task-Lead-Frontend-25.md`, whose plan the lead approved with rulings, `dev/v0101-team/followups/followup-Lead-Frontend-23.md`), whose independent review asked for a fix round (`dev/v0101-team/reviews/review-Frontend-18.md`, with the lead's notes), and that fix round, verified by the lead at the blob with no review of its own (`dev/v0101-team/reports/report-Frontend-33.md`, to `dev/v0101-team/tasks/task-Lead-Frontend-27.md` and the ruling that amended it, `dev/v0101-team/followups/followup-Lead-Frontend-24.md`). `editor/design.md:88` is the builders' account; what follows is the code's.

- **The control client's three closes commit a waiting stroke before they ask.** An unforced `close_tab`, `close_pane` and `close_all` run the registered flush of each tab they are about to ask (`flushTabEdits`, `state/tabs.svelte.ts:2677-2686`; `state/store.svelte.ts:1529`, `:1542`, `:1551`), so a stroke still inside the canvas's wait (`scheduleSerialize`, `editor/ExcalidrawCanvas.svelte:402-405`) is in the buffer when the tab is asked, and the tab answers blocked with unsaved changes (`paneCloseBlock`, `state/store.svelte.ts:1368-1372`). The same op closes it once the autosave, or on a live board the push-ok, has moved its saved mark. A forced arm commits nothing and closes at once, and a `cs pane` query flushes nothing.
- **A tab copied to another place commits first.** A move to another pane, a drop on a pane's edge, a reorder in its pane and a send to the pane's other side run the tab's flush before the copy (`moveTab`, `state/tabs.svelte.ts:5175`; `detachTabToPaneEdge`, `:5264`; `reorderTab`, `:4047`, after its two early returns at `:4038-4040`; `moveActiveTabToSide`, `:5224`). A reorder and a send keep the board, which seeds again from the copy when its buffer is not the board's own last serialization; that is why they commit too.
- **Every way the page hides or closes its window writes the recovery buffer first.** `flushEditsToRecovery` runs every registered flush, then svelte's synchronous flush, then writes every queued recovery write, logging each failure and throwing none (`state/tabs.svelte.ts:2688-2712`). `flushAndHideWindow` and `flushAndCloseWindow` call it before they ask the desktop (`state/closeConfirm.svelte.ts:52-72`), and every route calls one of them: the prompt's Hide and Close (`components/CloseConfirmOverlay.svelte:47-59`), the hide chord (`App.svelte:1036-1046`), the close-window command, the red dot at once and the host's hide command (`:1419-1423`, `:1430-1435`, `:1443-1445`), and the deck's Hide window and Close window (`state/commands/global.ts:288`, `:320`), whose `run` a chord a user assigned also runs (`App.svelte:633-652`). The unload handler calls it too (`:1514-1525`).

Pinned in `components/FileEditorTab.canvasEdits.test.ts`: the three unforced closes answering blocked and closing at the same op's second ask with the stroke on disk, and the three forced ones writing nothing (`:351-370`, `:372-381`); a move and a drop on a pane's edge carrying the stroke (`:317`, `:330`); on a live board, an unforced `close_tab` that pushes the stroke and closes after its ack, a forced one that pushes nothing, and a forced `close_pane` and `close_all` that push nothing before they answer (`:1012`, `:1029`, `:1043`). In `App.windowClose.test.ts`, the mounted app with a board that can be drawn on: the close-window command, the red dot while reconnecting, the prompt's Close, a `pagehide` and a `beforeunload` each leaving the stroke for the next open, read through the next load's decision over the file on disk (`:188-215`); the prompt's Hide, the hide chord, the host's hide command, the deck's two rows and a chord assigned to each leaving the stroke and a text tab's queued edit (`:236-269`). In `components/paneKeepAliveMount.test.ts`: a first stroke across a reorder and across a send to the other side (`:280`, `:288`). In the two reports each pin that changes behaviour is red first at its own assertion, the forced pane closes' push pins green at their commit and red under the mutation that the older pins let through; every mutation reds its expected set, and both own gates were green, the fix round's with the three static checks of the full gate.

**Rulings of the lead's, the owner's to overrule:**

- **A window's close does not ask about unsaved drawings, and it also writes a text tab's queued recovery write** (`followup-Lead-Frontend-23.md`, rulings 1 and 2); what a user would see either way is put to the owner in the range's report (`report-Frontend-31.md`, "The question for the host, in my words").
- **Every route of the page that asks the desktop to hide or close its window commits first, and the deck's Close window keeps what it did beyond that** (`task-Lead-Frontend-27.md`, ruling 1): it discards no session, which is raised as [the-decks-close-row-keeps-the-window-session](the-decks-close-row-keeps-the-window-session.md).
- **The tabs' flush is not guarded,** so a commit that throws stops a move or a close's ask before it reads a buffer that lacks the input (the lead's notes on the review; `state/tabs.svelte.ts:2677-2683`).
- **A reorder and a send to the side commit before their copy** (`followup-Lead-Frontend-24.md`), where the order had them unchanged.

**The acceptance at the tip.** The first point is met (`FileEditorTab.canvasEdits.test.ts:351-381`, red first for the unforced closes). The second is met by the mounted app's pins, red first (`App.windowClose.test.ts:210-215`), and is owed on a display: a real unload, a desktop webview destroyed with no unload event, and WebKit's keeping of a storage write made as a window dies are not shown by the test's environment.

**Owed at the first release candidate, rc0, on a display:** the range's eight steps and the fix round's eight (`report-Frontend-31.md` and `report-Frontend-33.md`, "What only a browser or the desktop can show" and "What only a display can show"). No browser and no desktop was driven.

**The costs, none hidden:**

- **A way a window goes that runs no page code commits nothing** (`editor/design.md:88`): raised as [a-host-side-hide-commits-no-waiting-stroke](a-host-side-hide-commits-no-waiting-stroke.md).
- **A local window cannot read the previous run's recovery buffer when the desktop restarts on another port, and the next open drops an entry once any write of the file follows its stamp** (`editor/design.md:88`): raised as [a-desktop-recovery-entry-ends-with-its-run](a-desktop-recovery-entry-ends-with-its-run.md) and [any-later-write-retires-a-recovery-entry](any-later-write-retires-a-recovery-entry.md). Restore of an entry on a live board is [restore-on-a-live-board-pushes-an-older-scene](restore-on-a-live-board-pushes-an-older-scene.md).
- **A forced pane close on a live board can hand the stroke to the authority where a forced tab close drops it:** raised as [a-forced-pane-close-pushes-a-waiting-stroke](a-forced-pane-close-pushes-a-waiting-stroke.md).
- **Hybrid Nav copies every tab with no commit before:** raised as [a-tab-copy-reseeds-over-a-first-stroke](a-tab-copy-reseeds-over-a-first-stroke.md).
- **A load that starts while a stroke waits loses it:** [a-stroke-in-the-debounce-is-lost-to-a-load](a-stroke-in-the-debounce-is-lost-to-a-load.md).
- **Two comments say more than the code does,** left by the fix round: the unload handler's "`beforeunload` + `pagehide` both fire reliably" (`App.svelte:1509-1511`) and the bridge's "Bury (hide, don't destroy)" (`api/desktop.ts:354`), which the desktop's bury contradicts for a workspace window.
- **A spurious recovery banner is possible** when a live board's file is written before the entry's stamp in other bytes than the entry's, by the range's report; inferred, not run.

**What is left:** the second point's readings on a display at rc0.
