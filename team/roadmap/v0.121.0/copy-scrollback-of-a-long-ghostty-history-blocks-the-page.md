# Copy scrollback of a long ghostty history blocks the page

Status: deferred from v0.120.0 at its close, where it was finding 13 of the ghostty row the v0.119.0 review raised; a speed item that needs its own measurement, not started.

## What was seen

Read at `e721c63bf` by the v0.119.0 review (`a/ghosttyVt.review.test.ts`, mirrored in the chan-dev archive under `releases/v0119/ga/review/`): the ghostty binding reads history cell by cell through grid references, about four wasm calls a cell. One screen of history at 120 by 40 reads in 1 to 1.6 ms, and Copy scrollback of 55,000 lines blocks the page for 1.7 s at 120 columns and 3.5 s at 200, three to six times ghostty-web's own build per row, measured in Node by the review's probes. Normal scrolling is unaffected; the whole-history reads (Copy scrollback, Select all) are what pay.

## Desired contract

1. A measurement first: the per-row cost of the history read on the vendored core, in Node and in Chrome, against ghostty-web's build and against a row read that takes the row's cells in one call (`ghostty_render_state_row_cells_get` over a history row, or a core call that yields a row's text), so the item knows what a faster read can reach before one is built.
2. Then, if the measurement bears it out: Copy scrollback and Select all of a long history read rows in one call each and keep the page responsive (a budget the measurement sets, below the 1.7 s and 3.5 s measured), without changing what is copied.

## Acceptance

1. The measurement is recorded in the item with its method and numbers.
2. If a change is built: a test pins the one-call row read's output equal to the cell-by-cell read's over the review's corpus, and a timed probe in Node pins the per-row cost under the budget the measurement set.
