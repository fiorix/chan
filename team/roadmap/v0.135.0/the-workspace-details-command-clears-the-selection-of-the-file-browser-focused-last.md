# The Workspace details command clears the selection of the file browser focused last, not the tab that shows the details

Status: moved to v0.133.0 by the owner on 2026-11-19 ("move them and cut"); built and not merged: `v0132/detailsclear` at `945c0720c`, with its guest legs and one confirm reading owed. Moved to v0.134.0 by the owner on 2026-11-20 ("the carry items and the current items in v0.133 move to v0.134 roadmap"). Moved to v0.135.0 by the owner on 2026-11-23 ("all other roadmap items will move to next version").

Record before the move: accepted for v0.132.0 by the owner on 2026-11-17, by survey at 2026-11-17T09:50Z, answering the first batch of candidates v0.131.0 took with no row ("Accept all six (recommended)"); not started.

Record: item 9 of `dev/v0131-team/reports/owner-candidates-1.md`, found while the launcher-target row was built (`dev/v0131-team/followups/followup-Web131-Lead131-6.md`, "Outside this row", and `dev/v0131-team/reviews/review-fbtarget-1.md`, note 8) and left out of that row as a workspace command, not one of its selection commands; the candidate was not verified by a run. [The launcher-target row](../done/the-launchers-file-commands-act-on-the-file-browser-focused-last-not-the-tab-just-made-active.md) kept the view commands and this one out of its boundary. Nothing is lost but a selection.

## What is there now

Read at `b73773a93`, by reading; not run. Paths are under `web/packages/workspace-app/src/`.

- The command `app.browser.showWorkspaceInfo` ("Workspace details", `state/commands/browser.ts:612-623`, offered in any tab of a workspace window) runs `showWorkspaceInfo` (`:149-157`): it takes the focused pane's active file browser tab (`activeBrowserTab`, `state/tabs.svelte.ts:1732-1737`) or opens a new one in the active pane, then runs `fbClearSelection()`, sets `browserSelection.showWorkspace`, and sets the tab's `showWorkspace` and `inspectorOpen` flags.
- `fbClearSelection()` with no argument clears `browserSelection` (`state/store.svelte.ts:5622-5626`), the selection of the surface the file commands act on, the one focused last (`:5523-5545`): a dock or any Files tab. `browserSelection.showWorkspace = true` sets that same surface's flag. The tab the command shows the details in is another object whenever the target is a dock, a Files tab in another pane, or none.
- A tab's inspector shows the workspace body only while its own surface's selection has `showWorkspace` and no path (`components/FileBrowserSurface.svelte:442-449`). The surface seeds that selection from the tab's flags once, at mount (`:148-160`, inside `untrack`), and writes the selection back to the tab on each selection change (`:211-230`). So, by reading: with the active tab as the target, its selection is cleared and the details show, as the surface's own menu row does for itself (`:339-349`). With a dock or another pane's Files tab as the target while a Files tab is active, the target's selection is cleared and its flag set (a dock has no inspector; another tab's inspector would show the workspace once its selection empties), while the active tab's surface keeps its selection, so its inspector opens on the selected file's details and the tab's `showWorkspace` flag is overwritten at its next selection change. With no Files tab active, a new tab opens and shows the workspace, seeded at mount, and the target's selection is lost.
- The surface's own Workspace details row clears only its own selection (`:339-349`, `fbSelectSingle(null, selection)`) and, in a dock, opens a new tab with the flags on it. That row is pinned (`components/FileBrowserSurface.test.ts:344-357`, the tab being the target). No test drives the command with a target other than the active tab (`state/commands/search.test.ts` and `registry.test.ts` list it only).

## Desired contract

1. The Workspace details command changes one surface's selection: the Files tab whose inspector shows the details, the focused pane's active Files tab or the new tab it opens. That tab's selection is cleared and its inspector shows the workspace, as the surface's own menu row does.
2. No other surface changes: a dock or a Files tab in another pane keeps its selection and its flags.
3. With no Files tab active, a new tab opens in the active pane showing the workspace details, as today.

## Boundaries

- `showWorkspaceInfo` in `state/commands/browser.ts` and the selection it addresses, with tests; the surface's own row stays as it is, and one function may serve both.
- The surface the launcher's file commands act on moves only by the existing rules: a new tab in the focused pane takes the keyboard and so the target, as any new Files tab does.
- The manual names the command nowhere today (by grep); `design.md:231` lists the view commands that read the active tab.

## Acceptance

1. Mounted tests, red at the base: a dock with a selected row is the target beside an active Files tab with a selected file; the command runs; the dock keeps its selection and its `showWorkspace` stays false; the tab's selection is empty and its inspector shows the workspace body. And with a terminal active in the focused pane and a dock as the target: a new tab shows the workspace and the dock keeps its selection. The surface's own row keeps its case (`FileBrowserSurface.test.ts:344-357`).
2. Restoring the clear of the shared selection turns the dock case red, and restoring the fix turns it green.
3. A browser check in a guest's Chrome, and the same in chan-desktop on WebKitGTK: a dock with a selected row, a Files tab with a selected file; the launcher's Workspace details; the tab's inspector shows the workspace and the dock's row is still selected.
4. `design.md:231` names Workspace details among the commands that act on the active tab alone.

## Accepted, 2026-11-17

The owner accepted this row by survey at 2026-11-17T09:50Z, answering the first batch of candidates v0.131.0 took with no row ("Accept all six (recommended)"). The draft left him no choice beyond the contract, with one note for his eye: none beyond accepting the contract. One note for his eye: the clearing itself is by design (the inspector shows the workspace only with nothing selected); the defect is which surface is cleared, and in the dock case the inspector may not show the workspace at all (by reading, unconfirmed by a run; the build's red test settles it).
