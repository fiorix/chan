# A pane keeps its margin and rounded corners on the window's own edges

Status: accepted for v0.130.0 by the owner on 2026-11-13; built and merged into the integration branch, not yet in a release.

Record: built by the owner on 2026-11-13 on the branch `v0130/flush-window-edges` (`71bf3ec5c`, `d9d3045fa`, over the v0.129.0 tag) and taken as v0.130.0's first merge (`342dbe791`) on his word, with no review before it ("no need; if there are problems we should catch on gates later"). He scoped v0.130.0 the same day as "the systemd and flush-window-edges, plus ghostty/terminal bug fixes", and asked for this row after the merge ("c. sure").

## What was there

Read at v0.129.0 (`ed89b7f7f`):

- Every pane drew as a card on all four sides: a 4px margin, a 1px border, rounded corners. A terminal kept its grid 8px inside that, so the first cell of a window's only terminal sat 13px in from the window's frame. The margin separates two panes; on the window's own sides it only took room from the content.
- In a transparent window the backdrop's hole behind a terminal took one radius for its four corners, read from the top-left one.

## Contract, as built

1. A pane reads which of its sides are the window's edge from the split tree alone (`windowEdges` in `web/packages/workspace-app/src/state/paneEdges.ts`), so a divider drag changes nothing, and `Pane.svelte` marks them `edge-top`, `edge-right`, `edge-bottom`, `edge-left`.
2. On an edge side the pane has no margin and square corners. The 12px channel between two panes is unchanged.
3. A side a docked file browser holds is not an edge: the pane keeps its margin from the dock as from a neighbour.
4. A window's only pane, which never draws the focus ring, drops its border on its edge sides too.
5. A terminal's grid keeps a 2px inset on an edge side (`--terminal-edge-inset` in `TerminalTab.svelte`) and the 8px one toward another pane, under a strip drawn in place, and beside an open Details panel.
6. In a transparent window the backdrop's hole takes each corner's own radius (`terminal/seeThroughBackdrop.ts`).

The workspace app's design document (`web/packages/workspace-app/src/design.md`) states the frame and its edges.

## Boundaries

- The workspace app's pane frame and terminal host only. No server, desktop or preference change.
- Not here: the insets inside the other kinds of tab (editor, file browser, graph, dashboard, extension), which the change does not touch.

## Acceptance

1. `paneEdges.test.ts` (a lone pane, row, column and nested splits, a docked side), `Pane.windowEdges.test.ts` (marks through a split and a close, the strip under the window tab bar and the auto-hide preference) and `seeThroughBackdrop.test.ts` (mixed corners). Green with the workspace app's vitest at the branch (716 files, 9,948 tests, by the owner's run); the release's gate runs them again on the integration tip.
2. Browser check 225 (`scripts/e2e/browser-smoke/checks/225-pane-window-edges.mjs`) reads the laid-out boxes: a lone pane fills the pane area with no margin, border or rounded corner; panes reach the area's sides and sit 12px apart; only a corner meeting the gap is rounded; a terminal's inset is 2px on a window side and 8px on a shared one or under a strip. Green headless on macOS against a debug server (Chrome for Testing 126) by the owner's run. The browser checks are outside the gate: run 225 and the terminal checks once in an isolated guest on the integration tip before the release.
3. Seen by the owner in a debug chan-desktop on macOS with ghostty terminals. Not exercised by anyone: an xterm.js terminal, whose fit reads the host's content box, and a transparent window.
