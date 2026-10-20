# The status pill and request cards sit over pane controls and cannot be moved

Status: raised for v0.108.0 by the owner's word of 2026-10-20 ("review the posision options of our notification, which is today tied to the top right side of the pane and some times it lands over other important UI areas; we must be able to move it around, especially when it cannot be closed and only minimised"); owner the frontend seat.

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

## Test server

Per `.agents/skills/test-server/SKILL.md`, a server where the owner can raise each case together: a long index run (the pill), a transfer, a pending upload or paste request card, a terminal with its find box open, an editor with Details open, the right dock shown and hidden, a narrow window. The owner tries the moves there before the row ships.

## Boundaries

`components/AppStatusBar.svelte`, `App.svelte` (`.request-corner`), `TransferBubble.svelte` and `RequestCard.svelte` only as far as their placement, a persisted UI preference for the position, their tests, a browser check. Not changed: what the pill shows, the request cards' reply rules, the survey overlay.

## Acceptance

1. The design recorded here with the owner's choice among the options.
2. Each position pinned in a component test, red first; the chosen position survives a reload; the collapsed state survives a reload.
3. A browser check that places the pill in each allowed position with the terminal find box and the editor Details panel open and reads that their controls are not under it.
4. The owner's verdict from the test server recorded here.
