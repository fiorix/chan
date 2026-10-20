# The status pill and request cards sit over pane controls and cannot be moved

Status: built on 2026-10-20 and 2026-10-21 on the seat's branch `v0108/ntfpos` and landed on `main` on 2026-10-21 by the merge `31cbfab8d`, the owner having passed it as done. By the owner's decisions below the pill stays where it is and every section the person cannot answer gains a close; the position options were not built. It closes at the GA as shipped.

Record before the build: raised for v0.108.0 by the owner's word of 2026-10-20 ("review the posision options of our notification, which is today tied to the top right side of the pane and some times it lands over other important UI areas; we must be able to move it around, especially when it cannot be closed and only minimised"); owner the frontend seat.

## What was seen

The owner reports the notification sits at the top right and lands over other important UI, and that a notification which cannot be closed, only minimised, cannot be moved out of the way.

What the code does (read 2026-10-20 at `4e9a68c8c`): the notification is not anchored to a pane. Two window-level layers sit in the top-right corner and float over whichever pane is rightmost:

- `components/AppStatusBar.svelte`, the status pill: `position: fixed; top: 48px; z-index: 28000`, right inset 12px or the docked Files browser width plus 12px. Its sections (index state, import progress, Transfers, the status message, Hybrid Nav, the session role) clear only when their source clears; only the status message has a close. The chevron collapses the whole pill to a "<" at the same spot; that collapse is local state, not persisted. It scales 1.04 on hover.
- `.request-corner` in `App.svelte`: `position: fixed; top: 5.5rem; bottom: 2rem; right: 0.6rem; width: 22rem`, holding the Transfers panel and the request cards (session handover, paste, upload). A request card cannot be minimised: the CLI waits on its reply. This column does not follow the right dock.

What they can cover: the terminal find box (`TerminalTab.svelte`, top 8px right 10px) and the terminal's right-edge scrollbar; the editor Details panel's title row and close button; the editor's fence badges and diagram hover actions near the top right; the search panel's header menu (the pill's z-index is above overlays and modals). No position setting, config key or drag exists; no surface in the app is drag-to-move today. The only position pin is `AppStatusBar.rightDock.test.ts` (the right inset); nothing pins `top: 48px` or the column's geometry.

## Desired contract

The person can move the pill and the request column out of the way of what they are working on, and the place they chose is kept; a notification that cannot be closed never has to sit over a control.

## Options for the design read

1. Corner choice: the pill and the column snap to one of the four corners, chosen from the pill's menu or by dragging and snapping; persisted per window. Small to build and test (four positions to pin), no free placement to clamp on resize. Recommended.
2. Free drag with a remembered offset, clamped into the window on resize and dock changes. Most flexible; more geometry to test, and a saved spot can land over a different control after a layout change.
3. Avoidance: keep the corner, and move the pill below or beside known controls (the find box, the Details header) when they are open. No user action, but a list of controls to keep current, and it does not answer "move it around".

Any option should also: persist the collapsed state with the position; let the request column follow the right dock as the pill does; drop the hover scale or keep it inside the pill's box.

## Owner decisions

Taken 2026-10-20 on the base test server (port 18103). The owner saw the pill over the terminal find box and over the file browser's Details close arrow, where the collapsed chip covers the arrow itself.

1. The notification to move is the pill: "i think the notification i want to be able to move around is the one stuck on reindexing.. anything on the terminal or a file browser will now sit behind that.. for example a file browser's details window". Of the collapsed chip over the Details close arrow: "no way to close it".
2. Closing comes first: "first of all let's fix the cases where there's no x button to close it; what's the case where we shouldn't be able to close a notification?" The owner agreed ("agree") to this rule:
   - Every pill section gets a close that hides that section until its content changes: a new index run or state, a different error, changed warnings, a new transfer or upload request.
   - The Transfers launcher can close while an upload runs, because a "Show transfers" launcher command reaches the panel.
   - The session role badge closes until the roster changes.
   - Hybrid Nav keeps no close; Esc and Enter end it.

   This widens the Boundaries below: the pill's controls change, what each section says does not.
3. No move, and no collapse across a reload. Once the closes were on the test server: "i think it's ok to not be able to move it, and it's ok to not keep it collapsed across reload". None of the three position options is built, and the pill keeps its top-right anchor. This narrows the Desired contract to closes, and the Acceptance below to closes in place of positions. As built, a close is page state too, and a reload shows every section again; the owner's word names the collapsed state, and the closes follow it.
4. Three follow-ons, accepted with "taking your recommendations":
   - A "Show workspace warnings" launcher command, since their dialog opens only from the pill's warnings line.
   - A close on the collapsed chip that closes every section it holds, under the same rule. The chip that covered the Details close arrow then leaves in one click.
   - The request column follows the right dock as the pill does.

   The hover scale stays.
5. Check 170's first run found the terminal find box under xterm's link-layer canvas at the base: both are at z-index 2 in one stacking context, and the canvas comes later, so a mouse click on the find input reached the terminal. Offered a fix on this branch (one CSS line in `TerminalTab.svelte`, a shared file the coordination map does not give this item) or a separate row, the owner chose the fix: "1".

## Test server

Per `.agents/skills/test-server/SKILL.md`, a server where the owner can raise each case together: a long index run (the pill), a transfer, a pending upload or paste request card, a terminal with its find box open, an editor with Details open, the right dock shown and hidden, a narrow window. The owner tries the moves there before the row ships.

## Boundaries

`components/AppStatusBar.svelte`, `App.svelte` (`.request-corner`), `TransferBubble.svelte` and `RequestCard.svelte` only as far as their placement, a persisted UI preference for the position, their tests, a browser check. Not changed: what the pill shows, the request cards' reply rules, the survey overlay.

## Acceptance

Restated by decisions 3 and 4 above; the first text asked for positions.

1. The design recorded here with the owner's choices.
2. Each close pinned in a component test, red first: every closable section, the collapsed chip's close, the Show transfers and Show workspace warnings commands, and the request column's right-dock inset.
3. A browser check that raises the pill over the terminal find box and over the file browser's Details close, expanded and collapsed, closes the pill's sections and reads that both controls are the topmost element at their own centre.
4. The owner's verdict from the test server recorded here.
