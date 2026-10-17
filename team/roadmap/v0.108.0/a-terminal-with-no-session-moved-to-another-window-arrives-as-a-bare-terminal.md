# A terminal with no session moved to another window arrives as a bare terminal

Status: carried into v0.108.0 at the v0.107.0 GA on 2026-10-17, still raised for a decision.

Record before the release: carried into v0.107.0 at the v0.106.0 GA on 2026-10-15, still raised for a decision.

Record before the release: raised on 2026-10-13 from the design read of the CLI-reload notice in the v0.106.0 round (the frontend seat's note and the review seat's read, `reports/clirld-design-Frontend106.md` and `reviews/review-Review106-clirld-design-1.md` in the round's bus); read at source, not reproduced; written down, not designed, not accepted for build.

## What was seen

By source: a terminal tab that holds no session id travels to another window as its kind and its title alone, and the target window opens a bare terminal in its place (`web/packages/workspace-app/src/components/Pane.svelte` 918 to 936 and 1054 at the round's integration branch). Its group, working directory, spawn command and environment are dropped, and nothing tells the user. A tab holds no session id before its first session frame and after its session has ended. A hand drag is slower than a local socket's first frame, so the cases a person can reach are a tab that cannot connect (the server restarting) and a tab whose session ended.

Not established: a reproduction; how often either case is met; what the target shows for a tab whose session ended.

## Desired contract

A terminal moved to another window arrives as what it was, or the target says what it could not carry.

## What to do

Reproduce both reachable cases in a browser with two windows; then decide between carrying the tab's own fields in the cross-window payload and a notice at the target, with the rule that a command's environment does not travel through a shared channel.

## Boundaries

`components/Pane.svelte` (the cross-window payload and its receiver), the tab constructors in `state/tabs.svelte.ts`. Not changed: the same-window move, which clones the live tab.

## Acceptance

1. Both reachable cases reproduced or shown unreachable, with the engine named.
2. The decision recorded here, and pinned at the store level and by one browser check with two windows.

## The owner's word 2026-10-16

Asked at the cut through one survey that listed the thirteen rows not shipped and the seven findings outside any item, with the lead's recommendation on each, and offered each row's own question with its cost (this row's line: "xwmove, a sessionless terminal moved to another window: carry with the carry design as written"), the owner answered: "Take all fourteen recommendations as listed (Recommended)". The row moves to v0.108.0 at the GA commit with the frontend seat's design as its first step (`reports/design-Frontend107-xwmove.md` in the round's bus: the reload snapshot carried for a sessionless terminal and a status naming what stayed, 3.25 hours).
