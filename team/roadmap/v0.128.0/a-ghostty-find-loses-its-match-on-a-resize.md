# A ghostty find loses its match on a resize

Status: raised by the v0.127.0 find follow-ups and accepted by the owner for v0.128.0 on 2026-11-09, when he kept the follow-ups' fallback for v0.127.0; not started. It touches the ghostty widget, so it lands on whichever widget is in place when it is built, before or after the [ghostty-web-ng item](chan-drives-ghostty-web-from-outside-through-its-private-internals.md).

## What is there now

In v0.127.0 find in a ghostty terminal hears every resize (`GhosttyViewportController.observeChanges`, `web/packages/workspace-app/src/terminal/ghosttyViewport.ts`), and on one it drops the highlight it wrote before ghostty-web repaints the new grid: the count keeps its total and shows no index (`? of n`) until Enter, Shift+Enter or a find command selects again, Enter then lands on the newest match and Shift+Enter on the oldest, and the viewport is not moved. A selection the user made stays. This is the fallback the follow-ups' work order allowed; the owner kept it for v0.127.0 on 2026-11-09.

The fallback was taken because libghostty-vt 1.0 drops its search's selected match on every resize, even one that changes only the rows and reflows nothing: after the next feed `index` and `active` are null and the scan restarts, and when it completes the total and the match list equal a fresh search's (the follow-ups' probe, kept with the round's raw data). `ghosttySearch.test.ts` pins that behaviour, so a later core that keeps the selection across a resize turns it red. The 1.0 wasm exports tracked grid references (`ghostty_terminal_grid_ref_track` and the calls around it), which follow their cell through a reflow; chan's binding (`src/terminal/ghosttyVt.ts`) does not bind them.

## Desired contract

1. After a resize, with or without a reflow, the match that was active stays active and highlighted once the scan has found it again, the count shows its index, and a match that was on screen before the resize is on screen after.
2. While the rescan runs the count shows a partial total and no wrong index, and a step pressed meanwhile behaves as a step does during any scan.
3. If the tracked position no longer holds a match (its row was pruned, or a resize split the text so it no longer matches), find falls back to today's behaviour: no highlight, `? of n`, the next step from the newest or oldest.
4. A selection the user made is never taken over, as today.

## Boundaries

- The fix tracks the active match's position through the core's tracked grid references and re-selects it after the rescan; no change to the core.
- Highlighting every match stays deferred.

## Acceptance

1. Vitest over the vendored core: a narrower and then wider resize that reflows the active match's line, and a rows-only resize, each keep the same match active with its index once the scan completes; a pruned or split match falls back as today.
2. Check 211's resize stage expects the same `k of 100` on the same row's match after the page narrows and widens, instead of `? of 100`.
3. The bound tracked references are freed with the search and the terminal, with a test that counts them.
