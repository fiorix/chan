# A picture inside a drawing is still painted at the engine's timing in an exported PDF

Status: a seeded Linux WebKitGTK observation passed; no picture omission was reproduced and no product repair is selected.

## Owner decision, 2026-10-06

Export a desktop page containing a drawing with an embedded picture, including rotated or cropped examples, and inspect the PDF. If omission is reproduced, make a targeted repair that includes the picture correctly or fails with its name. Defer implementation if observation does not establish the fault. If automation cannot perform the check, the owner will do it later and report; record that as awaiting observation, never as a pass.

## Seeded desktop observation, 2026-10-06

The Linux WebKitGTK desktop at `a64c6184739aa9b7c4c85f00124ef56292277b02` displayed a page containing an ordinary image and a drawing with one rotated picture and one cropped picture. A native screenshot and its pixel reading established that all three were visible before export, with the cropped-out ring absent. `cs export` and the window's own Export to PDF each completed and wrote a one-page PDF. Independent review inspected both files and found matching rendered pages containing the ordinary image and both drawing pictures, with the cropped ring still absent.

The command reported the target native window as its renderer and completed in 382 ms; the window export completed in 665 ms. These are individual functional observations from a two-CPU, four-GiB guest under recorded load, with no OOM kill, not latency bounds. The source, binaries and bundles stayed at the same product revision. The separate observation fixture was `eba65bf9a38019f9cea00f9f4d95676bc20634b0`, whose capture explicitly uses the eight-bit PPM format its reader accepts. Its guest validation included a missing-drawing-colour control that correctly failed the readiness predicate. An earlier attempt stopped before exporting when that reader rejected a sixteen-bit capture; it supplies no PDF result.

The tested seed did not reproduce the omission, so the owner's conditional product repair is deferred. This observation does not establish arbitrary drawings, macOS WKWebView or Windows WebView2. The owner's later display result can still establish a platform-specific failure. The [desktop export comparison](cs-export-hangs-where-the-ui-export-completes.md) retains its separate requirement for the owner's original document and window arrangement.

## Record before this decision

Every section below records the state before the dated decision above and is preserved as history. The dated decision governs the current scope.

Previous status: moved to v0.103.0 on 2026-10-05, before the v0.102.0 GA, still raised for a decision: the owner has not ruled on it and did not take it into v0.102.0, which shipped on 2026-10-05.

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
