# Closing a tab after a prompt can remove its neighbour

Status: shipped in [v0.100.0](../../release/release-v0.100.0.md): A close identifies its tab by id after the last await and is a no-op if the tab is gone, so a prompt can no longer make it remove a neighbour.

## What was seen

`closeTabAsync` in `web/packages/workspace-app/src/state/tabs.svelte.ts` captures `{ tabs, index, tab, side }` at entry, then awaits the draft prompt, the close confirm and the terminal close sink, and finally runs `tabs.splice(idx, 1)` with the index it captured before the awaits. If the pane changed while a dialog was up (a reorder, a peer's tab arriving, another close), the splice removes whatever now sits at that index: an unrelated tab goes away with no confirm and no dirty-buffer save, and the tab the user closed stays in the strip with a dead PTY. `closeTabsInPane` and `closePane` have the same capture-then-await shape.

This is the amplifier behind the terminal's double Ctrl+D ([terminal-chords-run-twice-or-not-at-all](terminal-chords-run-twice-or-not-at-all.md)): two close runs race on one captured index. It is reachable without that bug by anything that reorders a pane while a close prompt is open.

## Desired contract

A close acts on the tab it was asked to close, identified by id, wherever that tab is after the last await. If the tab is gone by then, the close is a no-op. The bookkeeping that follows a close (the reopen-closed record and the active-tab fixup) uses the re-resolved pane and side, not the captured ones.

## Boundaries

`web/packages/workspace-app/src/state/tabs.svelte.ts` (`closeTabAsync`, `closeTabsInPane`, `closePane`, `closeOtherTabsInPane`, `closeAllTabs`) with `state/tabs.test.ts` and `state/closeConfirm.test.ts`. The last two functions were added by the lead on 2026-09-20 after the review of the first fix confirmed the same capture-then-await defect in them: `closeOtherTabsInPane` wrote a filtered copy of its captured array back over the side, and `closeAllTabs` wiped tabs that arrived during its confirm and remembered the set it captured. The contract is about a close, not about three names. The review's one-line fix is not enough: re-resolving only the index inside the captured array still writes the reopen record and the active tab against a stale side. `tabs.svelte.ts` is shared with [a-tab-reorder-drops-live-tab-state](a-tab-reorder-drops-live-tab-state.md) and [a-canvas-edit-made-during-an-outage-can-be-lost](a-canvas-edit-made-during-an-outage-can-be-lost.md); one lane, sequenced.

## Acceptance

1. A test opens a close confirm on tab B, reorders the pane while it is pending, confirms, and asserts that B is closed and every other tab, its buffer and its session survive.
2. A test moves B to the other side of a split while the prompt is pending and asserts the same, with the reopen record and the active tab on the side B ended on.
3. Two concurrent closes of the same tab close it once.
4. The same cases pass for `closeTabsInPane` and `closePane`, and a tab that arrives during the prompt survives `closeOtherTabsInPane` and `closeAllTabs`.
