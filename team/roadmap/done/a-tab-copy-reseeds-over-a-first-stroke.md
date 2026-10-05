# A board reseeds when its tab is copied, and Hybrid Nav copies every tab with no commit first

Status: shipped in [v0.101.0](../../release/release-v0.101.0.md).

Record before the release: accepted for v0.101.0 by the owner on 2026-09-29; raised for a decision on 2026-09-29 by the lead (`dev/v0101-team/followups/followup-Lead-Frontend-24.md` in the development tree, "What is not built here, and what the lead raises"), from the fix round of the two closes that keep a drawing's last stroke ([two-closes-still-drop-a-drawings-last-stroke](two-closes-still-drop-a-drawings-last-stroke.md)), whose builder found it with runs in the mounted app and mapped it (`dev/v0101-team/followups/followup-Frontend-Lead-20.md`; `dev/v0101-team/reports/report-Frontend-33.md`, "The map for the item the lead raises"). Read at `e07f3862f`; that the pane hands its board the copy rests on the builder's runs.

## Owner ruling

Accepted on 2026-09-29 for v0.101.0. The owner accepted in one answer every recommendation the lead had put to them that day, and with that answer closed v0.101.0's intake under one rule: a raised item enters v0.101.0 only when it loses a user's data or weakens security and its fix is small and local, a test-only or infrastructure item only when it makes the release gate or a release job unreliable, and an item whose fix changes a contract or reopens excluded scope, or whose fault is a wrong state with a rare trigger, goes to v0.102.0. This item enters: a drawing's first stroke is lost with no word, and the fix is two or three calls in the tabs' store. The shape, as ruled, is the first of the two below: Hybrid Nav's entry and its commit commit every tab's waiting input before they copy, as the four moves do; the canvas is not changed. The mode's entry needs the commit as its commit does, by the reading of 2026-09-29 below, so the second acceptance point applies.

## What was seen

Lines at `e07f3862f`, under `web/packages/workspace-app/src/`. The host hands the canvas its tab's buffer (`components/FileEditorTab.svelte:1468`), and the pane renders file tabs by a list keyed on the tab's id (`components/Pane.svelte:1887`), so a copy of a tab under the same id keeps the board, which is handed the copy. The canvas seeds again on a new buffer unless the board is seeded and the buffer is its own last serialization (`editor/ExcalidrawCanvas.svelte:570-579`), which it takes at a seed and at a flush (`:449`, `:489`); a drawing's buffer after its load is the file's bytes, not that serialization, until the board's first flush writes it. So a stroke still inside its wait when the tab's object is replaced is taken off the board by the seed, if it is the first change since the board last seeded. The builder's runs showed it for a reorder and a send to the pane's other side, and a second stroke after a committed one kept.

This landing commits before the copy in a reorder, a move to another pane, a send to the other side and a drop on a pane's edge (`state/tabs.svelte.ts:4047`, `:5175`, `:5224`, `:5264`). Hybrid Nav copies every tab of the layout into its draft at its entry and copies the draft back into the layout at its commit, with no commit before either (`enterPaneMode`, `:4275-4278`; `commitPaneMode`, `:4494-4498`; `cloneLayoutState`, `:4262-4272`), and the store hands out the draft while the mode is up (`activeLayout`, `:1290-1292`). By the builder's map the commit is the one copy of a mounted tab left with no commit before it; whether the entry's draft replaces what the pane renders was not read. [hybrid-nav-leaves-a-live-drawing-unsaved](hybrid-nav-leaves-a-live-drawing-unsaved.md) is another fault of the same commit, and [a-stroke-in-the-debounce-is-lost-to-a-load](a-stroke-in-the-debounce-is-lost-to-a-load.md) the same seed reached by a load.

**Read again at `4c4ada0a1` on 2026-09-29,** under `web/packages/workspace-app/src/`; read, not run. `enterPaneMode`, `enterPaneModeTransaction` and `commitPaneMode` clone the layout with no commit before (`state/tabs.svelte.ts:4299-4314`, `:4320-4335`, `:4508-4539`), where the four moves commit first (`:4069`, `:5202`, `:5251`, `:5291`). What was left unread above is read: the entry's draft does replace what the pane renders. Each pane is handed its node from `activeLayout()` (`components/Workspace.svelte:25-27`, `:74`), which is the draft while the mode is up (`state/tabs.svelte.ts:1298-1300`), and the pane takes its tabs from that node (`components/Pane.svelte:165`). Against v0.100.0 the fault is new, by inference from two readings: v0.100.0 took the initial buffer as its baseline (`editor/ExcalidrawCanvas.svelte:102` at `v0.100.0`) and its content effect skipped a buffer equal to it (`:401-404` there), so a copy with the same bytes loaded nothing, where the baseline is now the library's serialization (`editor/ExcalidrawCanvas.svelte:449`, `:576`), which a freshly opened drawing's bytes are not.

## Desired contract

A stroke waiting on a board when its tab's object is replaced is on the board and in the buffer afterwards, whatever copied the tab.

## What to do

Either Hybrid Nav's entry and commit commit every tab's waiting input before they copy, as the four moves do, or the canvas does not seed again from a buffer that only the tab's copy brought. The lead ruled out the second for the fix round, since a reload or a restore that brings the same bytes back must still reseed, which needs a reading of every writer of the buffer and a plan of its own.

## Boundaries

`web/packages/workspace-app/src/state/tabs.svelte.ts` (`enterPaneMode`, `enterPaneModeTransaction`, `commitPaneMode`), or `src/editor/ExcalidrawCanvas.svelte` (the content effect), with their tests.

## Acceptance

1. A first stroke waiting at a Hybrid Nav commit is on the tab the pane holds afterwards and in its buffer; pinned red first in the mounted app.
2. The same at the mode's entry, if its draft replaces what the pane renders.

## What shipped

The build is on the integration branch and not on `main`, in ranges the lead accepted, with the combined gate green on Linux at the integration's tip. This record was written on 2026-10-02 from a reading of the code at that tip; what the acceptance of its range found beyond the code is in the round's records and was not read for it.

Hybrid Nav flushes every file tab's waiting editor input before it copies the layout: at entry and at a transaction's entry before the layout is cloned into the draft, and at commit before the draft is cloned back (`flushLayoutEdits`, called from `enterPaneMode`, `enterPaneModeTransaction` and `commitPaneMode`, `web/packages/workspace-app/src``/state/tabs.svelte.ts`). The canvas is not touched. Both acceptance points are pinned mounted in `components/paneKeepAliveMount.test.ts`: a first stroke waiting at entry survives in both trees, and one waiting at commit survives in the live tree. The changelog says it in a clause of the entry on a drawing's last stroke.
