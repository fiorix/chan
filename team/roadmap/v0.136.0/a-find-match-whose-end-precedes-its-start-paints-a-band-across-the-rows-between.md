# A find match whose end precedes its start paints a band across the rows between

Status: accepted by the owner on 2026-11-27 (the last section); not started. Not built in v0.135.0, so the GA commit moves it to the next version (D132). Moved to v0.136.0 at the v0.135.0 GA on 2026-11-27.

Record: found by the U3 review's sweep of matches wrapped across page boundaries (`dev/v0135-team/reviews/review-u3-r4b.md`, "Adjacent, outside the range", evidence `out/strad2-tip.out.txt` under that review's scratch). The core's own defect, a needle wrapped across a row end that is also an on-screen page boundary, goes upstream (`dev/v0135-team/upstream-libghostty-vt-issues.md`); this row is the widget's guard against one shape of it.

## What is there now

- Read on libghostty-vt 1.0.2 at 400 columns and 120 rows: for six of the sweep's positions the core lists a match whose end is 229 rows above its start (for example from row 344, column 397 to row 115, column 2).
- The widget publishes the core's ranges to its highlight layer as they come, so that range paints a band from row 115 to row 344.
- By reading, no other consumer of a match's range (the active match's placement, Copy, the step order) checks that its end follows its start.

## Desired contract

1. The widget's find keeps no match whose end precedes its start: such a range is not highlighted, not counted, not stepped to and not copied.
2. A well-ordered match, including one wrapped across rows, behaves as today.

## Boundaries

- The widget's find over the core's list in `web/packages/ghostty-web-ng/lib/`, with its tests. The core is not changed; its defect is reported upstream.

## Acceptance

1. A unit test over a core stand-in that lists an inverted range among good ones: the range is dropped from the count, the highlights and the steps; red at the base, with one mutant that keeps it.
2. The review's sweep at 400x120 on the real core: no highlighted range spans rows outside its match's own rows.

## Accepted, 2026-11-27

Accepted by the owner on 2026-11-27 ("yes add the guard as a row", `dev/v0135-team/decisions.md`, D132), answering the lead's recommendation of a small guard in the widget while the core's defect goes upstream. Drafted as a lead document and not built in v0.135.0.
