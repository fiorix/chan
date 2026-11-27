# The index status pill covers a terminal notice's Dismiss button

Status: closed by the owner at the v0.135.0 GA on 2026-11-27 (asked "Which of these four should close rather than move to v0.136.0?", he chose all four; D133, the Closed section), and it did not ship: `v0132/pillcover` at `123e03116` stays unmerged; closed at [v0.135.0](../../release/release-v0.135.0.md), which records the decision. Record before the close: moved to v0.133.0 by the owner on 2026-11-19 ("move them and cut"); built and not merged: `v0132/pillcover` at `123e03116`; check 211 read green interleaved with the base once the page starvation its own watcher caused was fixed (J127), and check 231 fixed; no reading of the range since. Moved to v0.134.0 by the owner on 2026-11-20 ("the carry items and the current items in v0.133 move to v0.134 roadmap"). Moved to v0.135.0 by the owner on 2026-11-23 ("all other roadmap items will move to next version").

Record before the move: accepted for v0.132.0 by the owner on 2026-11-16 ("Take all four recommendations"); not started.

Record: found by browser check 164 in the whole browser suite at v0.131.0's integration tip, and red there since v0.130.0 (`dev/v0131-team/reports/suite-131-164-diagnosis.md`). The check now waits for the cover to clear and fails naming any other cover; the app is unchanged.

## What is there now

While the search index rebuilds (after a directory rename, with its 30 s cooldown, `REBUILD_COOLDOWN` in `crates/chan-server/src/indexer.rs`), the app status bar's index pill (`web/packages/workspace-app/src/components/AppStatusBar.svelte`, `position: fixed`, `top: 48px`, `z-index: 28000`) sits over the top right of the pane. A terminal's CLI reload notice (`TerminalTab.svelte`, `.cli-reload-notice`) puts its Dismiss button there. A click on the button's centre lands on the pill's padding and does nothing; only the button's top few pixels stay clickable, and a click on the pill itself opens the indexing Dashboard.

## Desired contract

1. No pane control is covered by the status bar's pill while the pill shows: the pill avoids the pane's own controls, or the controls sit clear of it.
2. A click on the notice's Dismiss button dismisses it whether or not the index is rebuilding.

## Boundaries

- The pill's content and its own actions stay as they are; this row moves where it sits or where the pane's controls sit.

## Acceptance

1. A browser check that starts an index rebuild, raises a CLI reload notice, and clicks Dismiss at its centre: dismissed, red on today's layout.
2. The same in chan-desktop on WebKitGTK in the desktop guest.

## Closed, 2026-11-27

The owner closed the row at the v0.135.0 GA on 2026-11-27 (`dev/v0135-team/decisions.md`, D133): asked "Which of these four should close rather than move to v0.136.0?" about this row and three other rows carried from v0.134.0, he chose all four. At closing, by the status line: built on `v0132/pillcover` at `123e03116` and never merged; check 211 read green interleaved with the base once the page starvation its own watcher caused was fixed (J127), and check 231 fixed, with no reading of the range since. The branch stays unmerged. Not read: acceptance 1's browser check against the layout at `bba47f639`, and acceptance 2 in chan-desktop on WebKitGTK. Whether the pill still covers the notice's Dismiss button at `bba47f639` was not read. The row did not ship.
