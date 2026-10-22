# A diagram fence inside a blockquote never renders

Status: raised for v0.109.0 on 2026-10-22 by the lead, from the review seat's reading of the table-press item's range; closes in the round.

## What was seen

`diagramSource` in `web/packages/workspace-app/src/editor/widgets/diagram.ts` hands the renderer the fence interior's whole document lines, a blockquote's `> ` markers included, and `mermaid_render.ts` passes `source.trim()` to `mermaid.render` with no prefix stripped. A mermaid or mermaid-to-excalidraw fence inside a blockquote fails mermaid's type detection (mermaid 11.17.2 in Node on the quoted source: "No diagram type detected matching given configuration for text: > pie title Pets ..."; the same source at the top level and in a list item passes detection), so every quoted diagram shows its error face; the error names no line, so a press on the face takes the column-less fallback.

## Desired contract

A diagram fence renders the same inside a blockquote as at the top level or in a list item, and a renderer error on a quoted fence names the line and column of the fence's own text.

## What to do

Strip each interior line's container prefix up to the fence's column before the source reaches the renderer, the rule `codeTextStart` applies to a code line, and add each line's stripped prefix back to the column the renderer reports (the line needs no offset: the strip removes no line, and `parseErrorPos` carries the trim adjustment), so the caret on an error face lands where it does for an unquoted fence; a quoted fence whose code lines hold only their markers then has an empty source and, like an empty top-level fence, gets no widget; pins red first at the parent on the source a quoted fence hands a mocked renderer and on an error position's offset, with one mutant per guard.

## Boundaries

`widgets/diagram.ts` at `diagramSource` and the error-position path, the render entry if the stripping belongs beside `source.trim()`, and their tests; the editor's `design.md` diagrams paragraph where it states what the renderer receives. Changed with it: the table-press item's pin for a quoted fence whose one code line holds its marker alone, which gets no widget once its source is empty, and the doc comment above `placeCaretOnErrorLine`, which says the renderer reads a quote's markers as source; the face press's step then stops inside the interior for every fence that has a widget, so its bound guards an input no fence reaches, recorded as such. Not changed: the press and caret rules of the table-press item otherwise, the walker, the renderers' own parsing.

## Acceptance

1. Pins red first at the parent: a quoted fence's source reaches the renderer without its markers; an error column reported on a quoted fence maps back to the document's column; a quoted fence holding only its markers gets no widget; one mutant each.
2. `make web-check` green at the commit; check 180 alone three times at the landing in the integration guest.
