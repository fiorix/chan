# A reloaded window can come back focused on another pane than it saved

Status: accepted for v0.131.0 by the owner on 2026-11-13 ("yes" to a row); needs a reading before a fix.

Record: observed on 2026-11-13 while building browser check 226 of the [pane-focus keyboard](../v0.130.0/moving-pane-focus-to-a-file-browser-leaves-the-keyboard-in-the-terminal.md) row, in a guest's Chrome against the guest's own server, on both terminal backends; the cause is not read.

## What is there now

A window keeps its layout in two places, both written from one effect in `App.svelte` that reads `layout.activePaneId` among the rest: the address's hash (`s=`, written by `persistStateToHash` in `state/store.svelte.ts` after a 150 ms debounce through `history.replaceState`, skipped when the address would not change) and the server's session for the window (`PUT /api/session`, after 750 ms). The serialized layout marks the focused pane's leaf with `f: 1`. A reload restores from the hash first; the session's reconcile keeps the local focus while its pane survives (`reconcileLayout` in `state/tabs.svelte.ts`). A window opened again by its id alone, with no hash, restores from the session.

Two readings, both with a terminal in the top pane and a file browser in the bottom one:

- A plain sequence (a press on the terminal, a reload, a press on the browser's status line, a reload): before each reload the hash and the session both named the pane pressed last, and the reload restored it, with the keyboard in that pane.
- After check 226's arms (left and right presses into the terminal, the terminal's menu, Next pane, Hybrid Nav's commits, presses on the browser pane's strip and tab, arrows in the browser), a press on the browser's status line left the session naming the browser's pane and the hash naming the terminal's. The reload restored the terminal's pane, and the keyboard followed it there. The same window opened again by its id restored the browser's pane.

So after something in that sequence the hash stops following the focused pane while the session does. Which arm, and why, is not read: the hash write may be skipped, refused (the store's comment names WebKit's limit on `replaceState` calls, and Chrome has one of its own), or overwritten by a later write of an older layout.

## Desired contract

1. A reload restores the pane the window had focused, as a window opened again by its id does.

## Boundaries

- The hash write and the reload's restore in the workspace app. The session save and the reconcile are the reference, not the subject.

## Acceptance

1. A reading first: the arm of check 226's sequence after which the hash stops naming the focused pane, and the mechanism, with a control that keeps the hash current.
2. Then a browser check, red on today's code, that runs that arm, presses on another pane, reloads, and reads the focused pane and where the keyboard is.
