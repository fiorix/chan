# A press on a rendered table cell shows its source and a pixel of motion selects a range

Status: carried into v0.108.0 at the v0.107.0 GA on 2026-10-17, still raised for a decision.

Record before the release: carried into v0.107.0 at the v0.106.0 GA on 2026-10-15, still raised for a decision.

Record before the release: raised by the review seat on 2026-10-13 from its read of the markdown click range (N1 of `reviews/review-Review106-mdclick-range-1.md` in the round's bus); written down the same day by the lead as a row of its own, outside that item; owner the frontend seat; not reached in the v0.106.0 round

## What was seen

The markdown click item defers the reveal of hidden marks while the pointer is held, in the decoration walker's one selection. The widgets do not read that selection: the table (`web/packages/workspace-app/src/editor/widgets/table.ts` 123 to 128), the diagram (`widgets/diagram.ts` 603 to 611, 640 to 649), the date pill (`widgets/date.ts` 180 to 204), the wikilink pill (`widgets/wikilink.ts` 525 to 571), the image (`widgets/image.ts` 1297, 1375) and the page break (`commands/page_break.ts` 155) each read `state.selection` in their own provider, as `editor/design.md`'s providers paragraph says. Measured in the review seat's guest in Chrome for Testing 155, at the round's base and at the markdown click tip alike: a press on a rendered table cell replaces the table with its source at once (7 lines become 10) and one pixel of motion gives a range, 94 to 57. It is the markdown click item's mechanism on a widget.

## Desired contract

A press on a rendered widget does not swap it for its source under the held button; a click places the caret where a person would expect in the widget's source, and a small motion during the press does not select a range across text that was not on screen at the press.

## What to do

Measure each widget the same way the markdown click item was measured (the press, one pixel of motion, the release, one typed character; the selection and the document after each), in Chrome, for the table first; read how each widget's provider decides to show its source. Then design, to the review seat before code: the widgets reading the reveal selection the walker reads (the markdown click item's reader, which its review suggested live beside the visibility primitives in `decorations/selection.ts`), or a rule of their own.

## Boundaries

`web/packages/workspace-app/src/editor/widgets/` (the providers named above), `decorations/selection.ts`, their tests and a browser check. Not changed: the markdown click item's pointer rule and its hold.

## Acceptance

1. A written measurement per widget: what a press, one pixel of motion and a release select, at the base, with the engine named.
2. The decision recorded here.
3. If a change: a pin per changed widget, red first on its own assertion, and a browser arm that types one character after the click.

## The owner's word 2026-10-16

Asked at the cut through one survey that listed the thirteen rows not shipped and the seven findings outside any item, with the lead's recommendation on each, and offered each row's own question with its cost (this row's line: "tblclk, a press on a rendered table cell: carry"), the owner answered: "Take all fourteen recommendations as listed (Recommended)". The row moves to v0.108.0 at the GA commit with its record as it stands.
