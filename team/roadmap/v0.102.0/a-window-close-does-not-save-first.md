# A window's close does not save first, so a drawing's last stroke waits in the recovery buffer

Status: raised for a decision on 2026-09-29 by the owner's ruling on the close of a window, built under [two-closes-still-drop-a-drawings-last-stroke](../v0.101.0/two-closes-still-drop-a-drawings-last-stroke.md): in v0.101.0 a window's close does not ask about unsaved drawings, as built, and the ask is raised as an item of its own for a later version, so it is held under v0.102.0. The question is the builder's and the lead's, put to the owner on 2026-09-28 (`dev/v0101-team/reports/report-Frontend-31.md` in the development tree, "The question for the host, in my words"; `dev/v0101-team/followups/followup-Lead-Frontend-23.md`, rulings 1 and 2). Read at `4c4ada0a1`; nothing of the ask is built, and nothing was run.

## Owner ruling

Ruled on 2026-09-29. The owner accepted in one answer every recommendation the lead had put to them that day; for this question it was to keep the close as built in v0.101.0, a close that does not ask and that writes each tab's waiting input to the recovery buffer, and to raise the ask as an item of its own for a later version. Whether a window's close saves first, and in which version, is not ruled. It is not part of v0.101.0.

## What was seen

Lines at `4c4ada0a1`, under `web/packages/workspace-app/src/`. A window's close goes at once: the close-window chord, the red dot's Close, a reload and a browser tab's close. Before the window goes the page commits every board's waiting change and writes every queued recovery write to the recovery buffer (`flushEditsToRecovery`, `state/tabs.svelte.ts:2709`; `flushAndHideWindow` and `flushAndCloseWindow`, `state/closeConfirm.svelte.ts:58`, `:69`, called from `App.svelte:1048`, `:1426`, `:1437`, `:1448`, `components/CloseConfirmOverlay.svelte:49`, `:57` and `state/commands/global.ts:286`, `:318`), pinned in the mounted app (`App.windowClose.test.ts:210`, `:250`, `:271`). So a drawing's last stroke, and a text tab's edit of its last half second, are in the recovery buffer and not on disk, and the next open of the file shows "Unsaved changes from a previous session were found" with Restore and Discard (`components/FileEditorTab.svelte:995`). That is what landed with [two-closes-still-drop-a-drawings-last-stroke](../v0.101.0/two-closes-still-drop-a-drawings-last-stroke.md), whose second acceptance point asks that the stroke be left where the next open of the drawing finds it.

A tab's close asks about unsaved changes, and a window's close does not. If the window's close did as a tab's does, it would first save every unsaved tab and wait for the saves; the stroke would reach the disk, no banner would follow, and the red dot's prompt would need a way to show a save that was refused.

What the built shape rests on has two limits, each an item of its own: a local desktop window cannot read the previous run's recovery buffer when the desktop restarts on another port ([a-desktop-recovery-entry-ends-with-its-run](a-desktop-recovery-entry-ends-with-its-run.md)), and any later write of the file retires an entry ([any-later-write-retires-a-recovery-entry](any-later-write-retires-a-recovery-entry.md)). So on the desktop a close inside the unsaved interval, followed by a restart of the desktop, leaves no banner and no stroke; inferred from those two items and from `editor/design.md:88`, not run. What is at risk at a close is the input of the last fraction of a second, since the autosave writes the rest; inferred.

## Desired contract

The owner's to rule: a window's close saves each unsaved tab before the window goes and asks only when a save is refused or a terminal is running, so that the stroke is on disk and no banner follows; or a window's close stays as built.

## What to do

Decide. The shape that was put forward is a close that saves first and asks only on a refused save or a running terminal. Its costs, by reading: the close waits on its saves, and beside a folder that stopped answering it waits without end unless the wait is bounded; the red dot's prompt gains a state that shows a refused save; and it is a new close flow on every host of the page, with an order and a review of its own. Decide it with [a-desktop-recovery-entry-ends-with-its-run](a-desktop-recovery-entry-ends-with-its-run.md) and [any-later-write-retires-a-recovery-entry](any-later-write-retires-a-recovery-entry.md), since they say how far the banner can be trusted on the desktop.

## Boundaries

The close's routes in `web/packages/workspace-app/src/state/closeConfirm.svelte.ts`, `App.svelte`, `components/CloseConfirmOverlay.svelte` and `state/commands/global.ts`, the save funnel in `state/tabs.svelte.ts`, and the desktop's close prompt, with their tests; `editor/design.md` and the changelog. What the recovery buffer promises is the two recovery items'. A hide that the desktop makes without the page is [a-host-side-hide-commits-no-waiting-stroke](../v0.101.0/a-host-side-hide-commits-no-waiting-stroke.md).

## Acceptance

1. The owner's ruling is recorded: a window's close saves first, or stays as built.
2. If it saves first: a window closed with a stroke inside its wait leaves the stroke on disk, and the next open of the drawing shows no banner; pinned in the mounted app, red first.
3. If it saves first: a close whose save is refused asks, and a close beside a folder that does not answer ends within a bound that the item states; pinned.
4. If it stays as built: `editor/design.md` and the changelog say that a window's close does not save, and what the banner holds.
