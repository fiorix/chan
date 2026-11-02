# Copy scrollback of a long ghostty history blocks the page

Status: shipped in [v0.121.0](../../release/release-v0.121.0.md).

Record before the release: deferred from v0.120.0 at its close, where it was finding 13 of the ghostty row the v0.119.0 review raised; a speed item that needs its own measurement, not started.

## What was seen

Read at `e721c63bf` by the v0.119.0 review (`a/ghosttyVt.review.test.ts`, mirrored in the chan-dev archive under `releases/v0119/ga/review/`): the ghostty binding reads history cell by cell through grid references, about four wasm calls a cell. One screen of history at 120 by 40 reads in 1 to 1.6 ms, and Copy scrollback of 55,000 lines blocks the page for 1.7 s at 120 columns and 3.5 s at 200, three to six times ghostty-web's own build per row, measured in Node by the review's probes. Normal scrolling is unaffected; the whole-history reads (Copy scrollback, Select all) are what pay.

## Desired contract

1. A measurement first: the per-row cost of the history read on the vendored core, in Node and in Chrome, against ghostty-web's build and against a row read that takes the row's cells in one call (`ghostty_render_state_row_cells_get` over a history row, or a core call that yields a row's text), so the item knows what a faster read can reach before one is built.
2. Then, if the measurement bears it out: Copy scrollback and Select all of a long history read rows in one call each and keep the page responsive (a budget the measurement sets, below the 1.7 s and 3.5 s measured), without changing what is copied.

## Acceptance

1. The measurement is recorded in the item with its method and numbers.
2. If a change is built: a test pins the one-call row read's output equal to the cell-by-cell read's over the review's corpus, and a timed probe in Node pins the per-row cost under the budget the measurement set.

## Measurement

Measured on 2026-11-02 on the Linux build host (AMD Ryzen 9 8945HS, 16 threads, one-minute load average 0.3 to 0.7 during the runs), in Node v26.12.1 and in headless Chrome 150.0.7871.186 (not cross-origin isolated, so its clock steps in 0.1 ms; every total below is 4 ms or more). The subject is the core chan ships, the vendored libghostty-vt `tip` build at `ae0dc1b71` (`vendor/ghostty-vt/ghostty-vt.wasm`, SHA-256 `2b76c025...`), read through `ghosttyVt.ts` as it stands at `762f95240`; the comparison is ghostty-web's own build, the wasm of `ghostty-web` 0.4.0-next.20.g1858a59 (SHA-256 `794191cc...`), which chan's bundle does not load.

Method: one terminal of 40 rows with a 60,000-line limit is fed the v0.119.0 review's whole-history stream (row `i` is `i` and a space padded with `x` to one column short of the width, rows joined by CR LF, written in 64 KiB pieces), and each method reads every history row; the fastest of three runs counts. The same probe module runs in Node and in a Chrome page. ghostty-web's build keeps 544, 628 and 253 history rows of those streams whatever its line limit (about one page), so its rows are read in repeated passes up to the vendored history's row count; warm passes over a few hundred rows make its figure a floor. The methods:

- binding: `getScrollbackLine`, which takes a grid ref and reads the cell (and its style when it has one) column by column, two or three wasm calls a cell. With text it is Copy scrollback's read: ghostty-web's `translateToString(true)` over those cells, base code points only.
- ghostty-web: its build's `getScrollbackLine`, one `ghostty_terminal_get_scrollback_line` call a row, with the same text.
- viewport: the vendored core's render state over history (`ghostty_terminal_scroll_viewport` by row, `ghostty_render_state_update`, then `row_cells_next` and `row_cells_get` RAW per cell), 40 rows an update.
- format-row: `ghostty_terminal_selection_format_buf` with plain output, trimmed, over a one-row selection: one call a history row, text only.
- format-all: `ghostty_formatter_terminal_new` and `ghostty_formatter_format_alloc`, plain and trimmed with no selection: one call for the screen and its history, text only (55,040 lines for 55,000 rows of history, history first).

Microseconds a history row, Node / Chrome:

| Method              | 10,000 x 120 | 55,000 x 120 | 55,000 x 200 |
| ------------------- | ------------ | ------------ | ------------ |
| binding, cells      | 21.4 / 21.6  | 31.7 / 30.9  | 65.7 / 63.8  |
| binding, text       | 22.7 / 22.4  | 32.6 / 32.1  | 66.0 / 65.3  |
| ghostty-web, cells  | 2.6 / 2.0    | 2.7 / 2.1    | 4.3 / 3.3    |
| ghostty-web, text   | 3.7 / 2.9    | 3.7 / 2.9    | 5.9 / 4.6    |
| viewport, text      | 9.0 / 5.8    | 9.8 / 7.4    | 16.1 / 11.3  |
| format-row, text    | 1.0 / 1.0    | 1.6 / 1.6    | 2.2 / 2.2    |
| format-all, text    | 0.4 / 0.4    | 0.4 / 0.4    | 0.6 / 0.7    |

Whole history, milliseconds, Node / Chrome: Copy scrollback's read takes 1,790 / 1,763 at 55,000 x 120 and 3,630 / 3,592 at 55,000 x 200, which reproduces the review's 1.7 s and 3.5 s; viewport takes 541 / 409 and 884 / 624; format-row 86 / 85 and 122 / 124; format-all 21 / 23 and 35 / 39. The binding's read grows with the width because it is per cell, and per row its text read costs 6 to 14 times ghostty-web's build's, which is a warm floor, against the review's three to six. On this stream every faster method's text equals Copy scrollback's at every size.

The review's byte streams (its F2 and F6 corpus, at 80 x 5, each pushed whole into history, 107 rows) separate them. The formatter's row text differs from Copy scrollback's on 4 rows and from Select all's (the loop of ghostty-web's `getSelection`, reimplemented in the probe: the same cells, a blank cell as a space, a cluster in full) on 3, and in each the formatter's is the text on the screen: Copy scrollback drops erased cells instead of spacing them (`   3` copies as `3`; an overwritten wide character's row reads `ab` and the third character with no gaps) and keeps only a cluster's first code point (decomposed `e`, `n` and `a` with accents copy bare; a ZWJ family, a toned emoji and a flag lose all but their first code point); Select all adds a space after every wide character. The viewport read is cells, so it keeps both copies as they are.

Reading of the numbers: no export of the vendored core yields a history row's cells in one call; the render state takes two calls a cell or more, and its 2.5 to 6 times gain still leaves Copy scrollback of 55,000 rows at 200 columns blocking for 0.6 to 0.9 s. The one-call reads it has are the formatter's, which yield text, at 1 to 2 us a row or under 40 ms for the whole history, but they change what both copies hold in the cases above. A one-call read that keeps what is copied, as the contract asks, needs a core export of a row's cells like ghostty-web's `ghostty_terminal_get_scrollback_line`, so a rebuilt `ghostty-vt.wasm`. The budget for contract 2 is a whole-history read of 55,000 rows at 200 columns within 330 ms in Node (6 us a row), a tenth of today's: ghostty-web's build reads its cells at 4.3 us a row there, and the formatter, if the copies may change, reaches 40 ms.

The probes (the module both runtimes run, the Chrome driver over `--remote-debugging-pipe`, and the corpus check) and their output are kept with the round's evidence; none is in the product suite.

## Decisions

The owner's word of 2026-11-02 on contract 2, between a rebuilt core with a row-cells export, the formatter, the render state read and none, on the seat's recommendation of the formatter: "lets do formatter". Copy scrollback then holds the text the rows show, and contract 2's "without changing what is copied" gives way for it: an erased cell copies as a space and a cluster whole. Acceptance 2's equality is therefore with a cell-by-cell read of what the rows show (a blank cell a space, a wide character's spacer nothing, a cluster whole, trailing spaces dropped), not with the old Copy scrollback read, which differs from it on the rows the measurement lists.

The owner's word of 2026-11-02 on the Select all the build left open, which selected the wrong rows (Closing): "let's fix the select all as well".

## Next

Review and merge.

## Closing

Copy scrollback of a ghostty terminal is one call into the core. `VtTerminal.plainText()` (`web/packages/workspace-app/src/terminal/ghosttyVt.ts`) runs libghostty-vt's formatter over the active screen (`ghostty_formatter_terminal_new` and `ghostty_formatter_format_alloc`, plain, trimmed, soft wraps kept as line breaks): the history and then the rows on the primary screen, the rows alone on the alternate one. Its options struct and format enum are in the binding's `LAYOUT` and `ABI` tables, which the existing ABI tests check against the core's own type JSON. `ghosttyScrollbackText` uses it whenever the terminal's `wasmTerm` is the binding's terminal, which it always is on chan's ghostty backend, and reads the buffer row by row otherwise or when the format fails; `TerminalTab.svelte`'s Copy scrollback calls it. The trimming is the formatter's: a row's trailing spaces and blank cells go, and other whitespace a program printed (a no-break or ideographic space) stays, where the old read's `trimEnd` dropped it. The text is built in the wasm instance's memory, which keeps its high-water mark, so the first copy of a long history grows that terminal's memory by about the text's size (11 MB for 55,000 rows at 200 columns) until the terminal closes. The workspace app's `design.md` (A terminal's backend and its masking) states the read.

Verified by `src/terminal/ghosttyVt.text.test.ts`, red first against stubs that kept the old behavior (27 of its tests failed at their assertions; the fallback test passed, as it should): every stream of the review's corpus (its F2 and F6 streams, now the shared fixture `src/__tests__/ghosttyStreams.ts`) reads equal to the cell-by-cell read of what its rows show, on screen and again once pushed into history; accents, a toned emoji, wide characters and a cursor-forward gap read as shown; trailing spaces go and a no-break or ideographic space stays; the alternate screen reads its rows and no history; an empty terminal reads empty; Copy scrollback's text reads no buffer row from the binding's terminal and reads the buffer from any other. The timed probe pins 55,000 rows at 200 columns under the budget of 6 us a row, 330 ms, at the best of three runs; it runs in about 35 ms in Node. Six mutations of the read (trim off, unwrap on, VT output, the buffer read always, a correct row-by-row read in place of the formatter, which the timed probe failed at 3,729 ms, 67.8 us a row) each failed a named assertion; a seventh, dropping a final `trimEnd`, survived, which showed that `trimEnd` changed only a last row's non-space whitespace, so it was removed and the formatter's rule pinned instead.

Select all and selection copies take the same read. In ghostty-web 0.4.0-next.20.g1858a59 Select all was not a whole-history read but selected the wrong rows: `selectAll` put the selection at the absolute row its viewport offset counts (the lines scrolled back), one screenful counted from the top of the history; driven in Node through ghostty-web's own `SelectionManager` over the binding's terminal, with rows 8 to 11 shown and 8 rows of history, it copied rows 0 to 3. Every selection copy went through its `getSelection`, which reads the selected rows a cell at a time and adds a space after each wide character. ghostty-web has no public call for either, so `web/packages/workspace-app/src/terminal/ghosttySelection.ts` reaches the selection manager, the third seam of that kind the webdev skill lists: its `selectAll` selects the history and the screen, as on xterm.js, and its `getSelection` is `plainText` over the selection's corners, so every copy of a selection (the copy chords, the menu, ghostty-web's copy on mouse release, double and triple click, the context menu's textarea) is one formatter call. `plainText` takes a range for it, its corners in either order (the core orders them), its rows clamped to the buffer. The shape is feature-detected; one it does not recognize, or another core, keeps ghostty-web's selection and the tab logs a warning. Verified by `ghosttySelection.test.ts` over ghostty-web's real `Terminal` and `SelectionManager` wired as `open()` wires them, red against a stub that installed nothing (5 tests failed at their assertions): ghostty-web's own Select all is pinned as observed (rows 0 to 3), so an upstream fix shows here; chan's selects rows 0 to 11 and copies them; a selection reads its wide characters once where ghostty-web's own read puts a space after each; a selection made backwards, on one row and across two, reads as one made forwards; ghostty-web's own copy path copies the same text; no selection copies nothing; and a terminal with no selection manager, or one over another core, keeps ghostty-web's. The range read is pinned in `ghosttyVt.text.test.ts` against the cell-by-cell read of what the rows show, for every row of every corpus stream across history and screen, mid-row, past the last row and backwards (24 tests red against a stub that ignored the range). Seven mutations (ghostty-web's Select all kept, the own read kept, Select all over the screen alone, the range ignored, the rows unclamped, a range past the end not empty, a backwards range past the end) each failed a named assertion; an eighth, dropping the seam's own reordering of the corners, survived, which showed the core orders them, so the reordering was removed.

Open: no browser or desktop window ran the change, so a mouse selection, the copy chords and Select all were exercised through ghostty-web's classes in jsdom and Node, not on a page; the owner's hand check covers them. The budget is pinned in Node only: the measurement found Chrome within 10 percent of Node for this read (35 and 39 ms), and WebKit, the desktop's webview, was not measured.
