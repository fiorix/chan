# An empty table cell breaks the editor's table grid

Status: accepted scope for v0.98.0, raised by the owner. The behavior is reproduced and its mechanism is confirmed against the live tree.

## What was seen

A GFM table whose header row carries no labels does not render as a grid in the editor. `| A | B |` renders; the same table with `| | |` as its first row stays raw pipe-and-dash text.

## What was verified

The reported case reproduces, the mechanism is one line of chan's own code, and the defect is wider than the report.

`web/packages/workspace-app/src/editor/widgets/table.ts` builds the grid from the syntax tree: `extractTable` collects `TableCell` children of `TableHeader` and each `TableRow`, and bails with `if (!foundHeader || headers.length === 0) return null`, which drops the decoration and leaves the source visible.

`@lezer/markdown`'s GFM table parser emits no node at all for an empty cell. Its `parseRow` counts a cell for every pipe boundary but only calls `parseCell` when it saw non-space content, so `| | |` parses to a `TableHeader` whose children are three `TableDelimiter` nodes and zero `TableCell`. Observed tree for `| | |` over `|---|---|`:

```
Table[8,33]
  TableHeader[8,13] TableDelimiter[8,9] TableDelimiter[10,11] TableDelimiter[12,13]
  TableDelimiter[14,23]
  TableRow[24,33] TableDelimiter[24,25] TableCell[26,27] TableDelimiter[28,29] TableCell[30,31] TableDelimiter[32,33]
```

So `headers` is empty, the guard fires, and nothing renders. The column count is recoverable (three delimiters), but not from the nodes the code reads.

Three findings beyond the report:

1. **It is unconditional.** A heading on the following line is not a factor. `| | |` fails to render with a blank line before `# Foo`, with `# Foo` tight against the table, with body rows, without body rows, in the middle of a document, and at one column (`|  |`). The labelled control renders in every one of those same positions. Whitespace-only cells (`|   |   |`) behave exactly like empty ones, because `parseRow` skips spaces and tabs. A cell holding a non-breaking space does render, which is the workaround available today.

2. **A partially empty row misrenders silently, which is worse.** The guard only catches the all-empty header. One empty cell among labelled ones passes the guard and the grid comes up with that column collapsed and every later cell shifted left. `| A |  | C |` over three-column body rows renders `th = ["A", "C"]`, so `C` sits above column two. `| 1 |  | 3 |` as a body row renders `td = ["1", "3"]`, so `3` sits under `B`. The reader has no signal that a column was dropped.

3. **The editor and the export disagree about the same source.** PDF export, slide preview and present, and copy-as-HTML all go through `renderMarkdown` (`web/packages/workspace-app/src/api/markdown.ts`, `marked` with `gfm: true`), which is correct in every one of these cases: `| | |` yields `<th></th><th></th>`, and neither the header hole nor the body hole loses a column. So the same file is a grid on export and raw pipes in the editor, or a correct grid on export and a shifted grid in the editor.

Verified by running the real `chanMarkdown()` grammar and the real `tableDecorations()` widget under the package's own vitest and jsdom setup, with the caret parked outside the table so the selection-intersect suppression (`selectionInRange`) can never be the reason a table is missing. That suppression is a genuine confounder: any table starting at offset 0 in a fresh editor is legitimately un-rendered because the default caret sits inside it, and a probe that does not account for it reads every table as broken.

## Why that matters

An unlabelled header row is the ordinary way to write a layout table or a matrix whose columns need no names, and it is what a pasted table often looks like. The editor is chan's document surface, so a table that renders everywhere else and not there reads as chan not supporting the file it just opened. The column-collapse case is the more serious half: it produces a plausible grid that states something the source does not.

## Desired contract

A cell that is empty is a cell. The editor's grid has exactly the columns the source has, in the source's order, for every row, and it matches what `renderMarkdown` produces for the same source. A table renders whenever its header row exists, regardless of whether any cell in it carries text.

Nothing else about the widget changes: it stays read-only, stays atomic, and stays suppressed while the selection intersects its source range.

## Boundaries

`extractTable` and `extractCells` in `web/packages/workspace-app/src/editor/widgets/table.ts`, plus tests. No grammar change: `@lezer/markdown` is a dependency and its `parseRow` is correct GFM (the cell count it reports is right; it just does not materialize a node for an empty cell). No change to `renderMarkdown`, to the PDF or slide paths, or to `TableWidget.toDOM`, whose per-cell inline rendering already handles an empty string.

## Fix proposal

Read the row's structure from its `TableDelimiter` nodes instead of its `TableCell` nodes, and take cell text from the source between them.

For a row node spanning `[from, to)`, collect the child `TableDelimiter` ranges in order and cut the row into the segments between them: the segment before the first delimiter, one segment between each adjacent pair, and the segment after the last. A segment is a cell when it lies between two delimiters, or when it is non-blank. Trim each segment and use it as the cell source.

That rule reproduces `parseRow`'s own cell count exactly, which is the property that makes it correct rather than approximately correct:

- `| A | B |` has delimiters at both edges, so the leading and trailing segments are empty and skipped, and the two interior segments are the cells.
- `| | |` has the same shape with blank interiors, so it yields two empty cells rather than none.
- `A | B` (GFM permits no outer pipes) has one delimiter, and both outer segments are non-blank, so it yields two cells.
- `A | ` yields one cell, because the trailing segment is blank and there is no delimiter after it to force it.
- An escaped `\|` never produces a `TableDelimiter`, so it stays inside its cell with no special handling. Confirmed: `| A \| B | C |` parses to two `TableCell` nodes today and the delimiter positions agree.

The header guard then becomes "there is a `TableHeader`" alone. `headers.length === 0` stops being reachable for any table the parser accepted, because a row that produced a `Table` node has at least one delimiter.

Ragged rows keep today's behavior: a body row with fewer or more cells than the header renders with its own cell count, unchanged. Normalizing ragged rows is a separate question and is not in this item.

Two alternatives were considered and are worse. Counting delimiters only to pad the header out to the right width fixes the reported case but leaves the column-collapse case intact, which is the more damaging half. Re-splitting the raw row text on unescaped pipes in the widget duplicates the parser's escape handling in a second place, and the delimiter nodes already encode exactly that decision.

## Acceptance

1. `| | |` over `|---|---|` renders a grid with two empty `<th>` and the body row's cells under them, at one column and at two, with and without body rows, at the start of a document and in the middle of one, and with `# Foo` on the following line both tight and blank-line separated.
2. `| A |  | C |` renders three `<th>` with the middle one empty, and its three-cell body rows line up under the header they belong to. Same for an empty cell in the first and last header position.
3. `| 1 |  | 3 |` as a body row renders three `<td>` with the middle one empty.
4. For each source in 1 through 3, the widget's cell text per row equals the cell text `renderMarkdown` produces for the same source. This is the pin that keeps the editor and the export from drifting apart again.
5. A row with no outer pipes, a row with an escaped `\|`, and a ragged short and long body row all render exactly as they do today.
6. The existing `table.test.ts` cases pass unchanged, including bold-in-a-cell and the past-the-parse-frontier case.
7. Every case is asserted with the caret parked outside the table, so no assertion can pass or fail because of selection-intersect suppression.

## Implementation and validation

`extractCells` derives each row from its `TableDelimiter` ranges and keeps every segment between adjacent delimiters, including blank segments. Non-blank outer segments preserve rows without outer pipes, escaped pipes remain part of their source segment, and ragged rows retain their authored width. `extractTable` now requires the header node rather than at least one materialized `TableCell`.

The table widget tests cover empty and whitespace-only one- and two-column headers with and without body rows, tables at the document start and middle, tight and blank-line-separated following headings, empty cells at every header position, an empty body cell, rows without outer pipes including an unforced blank trailing segment, an escaped pipe, and ragged rows. Every new editor state parks its caret after the table, and the empty-cell fixtures compare the widget's row text with the real `renderMarkdown` output. The focused Vitest run passes all 17 table tests.

Ragged and outer-pipe-free rows assert the widget's authored widths directly rather than comparing them with `renderMarkdown`: `marked` pads a short row and truncates a long row to the header width, while this item's contract deliberately preserves the widget's existing per-row cell count. The escaped-pipe fixture still cross-checks the two renderers because its row is not ragged.

An integrated `make web-check` diagnostic under a load average of 8.15 on eight cores, concurrent with a release `rustc` link, passed 3,834 of 3,835 workspace-app tests but hit the ten-second import-hook timeout in unchanged `fbClipboard.test.ts`. The exact file then passed 9/9 in isolation in 4.88 seconds under the remaining load. The round's clean baseline gate independently ran the unchanged file's 9 tests in 494 ms and passed all 384 test files, confirming that the diagnostic red measured container saturation rather than an Editor regression. This diagnostic is not reported as the scoped gate.
