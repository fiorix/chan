# The owner's display readings need one checklist

Status: accepted for v0.104.0 by the owner's word of 2026-10-08 as a checklist, not built work; the team prepares the fixtures and exact steps, only the owner takes the readings, and the readings are not settled by this version.

## What was seen

Readings that only the owner can take on a display were left at two cuts. From v0.102.0's Known gaps, seven acceptances on closed rows: a hide made on the connecting page ([a-connecting-page-hide-lives-in-memory-alone](../done/a-connecting-page-hide-lives-in-memory-alone.md), acceptance 2), a connected record that does not say whose socket ([a-connected-record-does-not-say-whose-socket](../done/a-connected-record-does-not-say-whose-socket.md), 2), the desktop's recovery entry ([a-desktop-recovery-entry-ends-with-its-run](../done/a-desktop-recovery-entry-ends-with-its-run.md), 1), a repeated element id ([a-repeated-element-id-gets-a-new-id-at-every-seed](../done/a-repeated-element-id-gets-a-new-id-at-every-seed.md), 3), a deck's PDF and its images ([a-slide-decks-pdf-lacks-the-images-it-shows](../done/a-slide-decks-pdf-lacks-the-images-it-shows.md), 7), the printed line that opens the devserver ([no-printed-line-opens-the-devserver-in-a-browser](../done/no-printed-line-opens-the-devserver-in-a-browser.md), 5), and the desktop's probe and a gateway 404 ([the-desktop-probe-takes-a-gateway-404-as-ready](../done/the-desktop-probe-takes-a-gateway-404-as-ready.md), 3). From v0.103.0's withdrawn rows: the drawing's picture in an exported PDF and in `cs export`, on the original document and window arrangement ([a-drawings-picture-waits-on-the-engine-in-a-pdf](../done/a-drawings-picture-waits-on-the-engine-in-a-pdf.md), [cs-export-hangs-where-the-ui-export-completes](../done/cs-export-hangs-where-the-ui-export-completes.md)), and pending edits at a desktop hide on an engine other than WebKitGTK ([a-host-side-hide-commits-no-waiting-stroke](../done/a-host-side-hide-commits-no-waiting-stroke.md)).

## Desired contract

One compact checklist the owner can take in one sitting: for each reading, the fixture (a file, a workspace, a devserver state), the exact steps, what a pass looks like and what a fail looks like, and where to write the result.

## What to do

The desktop seat builds the fixtures and writes the exact steps per reading; the lead assembles the checklist in the release report's shape and asks the owner to take the readings when the candidate is ready. Nothing is marked taken by the team.

## Boundaries

Fixtures under `scripts/e2e/` or a dedicated fixture directory the desktop seat names; the checklist text in the round's reports and the release report. No product change.

## Acceptance

1. The checklist lists every reading above with its fixture, steps, pass and fail, and the engine or display it needs.
2. Each fixture is run once by the team on Linux WebKitGTK or in a browser to show the steps reach the reading, with its record; that run is not the owner's reading.
3. The owner's readings, when taken, are recorded by the owner's word; a reading not taken at the cut stays listed as open.
