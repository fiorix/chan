# A pane close from the control client, and a window's close, can still drop a drawing's last stroke

Status: raised for a decision on 2026-09-27 by the independent review of the fix that keeps a drawing's last stroke ([the-frontend-review-remainder-has-no-owner](the-frontend-review-remainder-has-no-owner.md); `dev/v0101-team/reviews/review-Frontend-10.md` in the development tree, finding 3), which read the code at `3dc581d3b`; read again in code at `b1ef073ae`, where both hold, and not reproduced. Recommendation: accept for v0.101.0.

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
