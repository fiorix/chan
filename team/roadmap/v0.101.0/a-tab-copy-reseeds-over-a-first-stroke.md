# A board reseeds when its tab is copied, and Hybrid Nav copies every tab with no commit first

Status: raised for a decision on 2026-09-29 by the lead (`dev/v0101-team/followups/followup-Lead-Frontend-24.md` in the development tree, "What is not built here, and what the lead raises"), from the fix round of the two closes that keep a drawing's last stroke ([two-closes-still-drop-a-drawings-last-stroke](two-closes-still-drop-a-drawings-last-stroke.md)), whose builder found it with runs in the mounted app and mapped it (`dev/v0101-team/followups/followup-Frontend-Lead-20.md`; `dev/v0101-team/reports/report-Frontend-33.md`, "The map for the item the lead raises"). Read at `e07f3862f`; that the pane hands its board the copy rests on the builder's runs. Recommendation, by the lead's rule for this landing: accept for v0.101.0, since a stroke is lost with no word.

## What was seen

Lines at `e07f3862f`, under `web/packages/workspace-app/src/`. The host hands the canvas its tab's buffer (`components/FileEditorTab.svelte:1468`), and the pane renders file tabs by a list keyed on the tab's id (`components/Pane.svelte:1887`), so a copy of a tab under the same id keeps the board, which is handed the copy. The canvas seeds again on a new buffer unless the board is seeded and the buffer is its own last serialization (`editor/ExcalidrawCanvas.svelte:570-579`), which it takes at a seed and at a flush (`:449`, `:489`); a drawing's buffer after its load is the file's bytes, not that serialization, until the board's first flush writes it. So a stroke still inside its wait when the tab's object is replaced is taken off the board by the seed, if it is the first change since the board last seeded. The builder's runs showed it for a reorder and a send to the pane's other side, and a second stroke after a committed one kept.

This landing commits before the copy in a reorder, a move to another pane, a send to the other side and a drop on a pane's edge (`state/tabs.svelte.ts:4047`, `:5175`, `:5224`, `:5264`). Hybrid Nav copies every tab of the layout into its draft at its entry and copies the draft back into the layout at its commit, with no commit before either (`enterPaneMode`, `:4275-4278`; `commitPaneMode`, `:4494-4498`; `cloneLayoutState`, `:4262-4272`), and the store hands out the draft while the mode is up (`activeLayout`, `:1290-1292`). By the builder's map the commit is the one copy of a mounted tab left with no commit before it; whether the entry's draft replaces what the pane renders was not read. [hybrid-nav-leaves-a-live-drawing-unsaved](hybrid-nav-leaves-a-live-drawing-unsaved.md) is another fault of the same commit, and [a-stroke-in-the-debounce-is-lost-to-a-load](a-stroke-in-the-debounce-is-lost-to-a-load.md) the same seed reached by a load.

## Desired contract

A stroke waiting on a board when its tab's object is replaced is on the board and in the buffer afterwards, whatever copied the tab.

## What to do

Either Hybrid Nav's entry and commit commit every tab's waiting input before they copy, as the four moves do, or the canvas does not seed again from a buffer that only the tab's copy brought. The lead ruled out the second for the fix round, since a reload or a restore that brings the same bytes back must still reseed, which needs a reading of every writer of the buffer and a plan of its own.

## Boundaries

`web/packages/workspace-app/src/state/tabs.svelte.ts` (`enterPaneMode`, `enterPaneModeTransaction`, `commitPaneMode`), or `src/editor/ExcalidrawCanvas.svelte` (the content effect), with their tests.

## Acceptance

1. A first stroke waiting at a Hybrid Nav commit is on the tab the pane holds afterwards and in its buffer; pinned red first in the mounted app.
2. The same at the mode's entry, if its draft replaces what the pane renders.
