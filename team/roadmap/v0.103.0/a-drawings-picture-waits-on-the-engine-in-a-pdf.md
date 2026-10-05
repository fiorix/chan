# A picture inside a drawing is still painted at the engine's timing in an exported PDF

Status: moved to v0.103.0 on 2026-10-05, before the v0.102.0 GA, still raised for a decision: the owner has not ruled on it and did not take it into v0.102.0, which shipped on 2026-10-05.

Record before the move: raised for a decision on 2026-10-03 by the lead, from the build and the independent review of [a-slide-decks-pdf-lacks-the-images-it-shows](../done/a-slide-decks-pdf-lacks-the-images-it-shows.md); the owner has not ruled on it. Read in the code on that item's range; no WebKit ran. Ruled on 2026-10-03: see Owner ruling.

## Owner ruling

On 2026-10-03 the owner ruled, as the lead recommended: the owner's own reading on a display first, a page with a drawing that holds a picture, exported from the desktop app; a build is ruled after it. The fault is read in the code and not seen, and nothing is built until that reading.

## What was seen

That item's fix paints each `<img>` of a page itself: the snapshot decodes the image in the app's own document and draws the bitmap where the page puts it, so nothing waits on when an engine loads an image nested in the page's SVG document. Two things on a page still come from that document at the engine's timing: an `<image>` inside an inline SVG, which is how a drawing with an embedded picture reaches a page, and the bundled code font, a `url()` in a style. On WebKit, where the measured fault was a nested image not yet loaded when the page was drawn, either can be missing from the PDF with no named failure.

## Desired contract

Not written yet. The item's own contract is that every image a page shows is in the PDF or the export fails by the image's name; a drawing's picture is outside it today.

## What to do

Rule whether it is built in this version. Lifting an `<image>` as an `<img>` is lifted needs its transform inside the drawing (a rotation, a crop), which the marker's box does not carry; and showing the fault needs WebKit, which the build guest does not have. A reading on the owner's display with a drawing that holds a picture would say whether it is met in practice.

## Boundaries

`web/packages/workspace-app/src/editor/pdf_snapshot.ts` and its tests.

## Acceptance

1. The ruling is recorded.
2. If it is built: an exported page that shows a drawing with an embedded picture holds that picture, or the export fails by its name; pinned in the smoke, and read on a display under WebKit.
