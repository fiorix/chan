# Check 103 reads the Outline's first slide thumbnail instead of the overlay

Status: raised for v0.109.0 on 2026-10-21 by the lead, from the review seat's measurement of the check alone at the integrated tip; closes in the round.

## What was seen

`scripts/e2e/browser-smoke/checks/103-slide-blank-band.mjs` reads the slide preview overlay's content through an unscoped `document.querySelector(".md-slide-preview-content")`. Once the editor's Outline card has rendered its slide thumbnails (`web/packages/workspace-app/src/components/SlideThumbnail.svelte` 44), that selector matches the first thumbnail ahead of the overlay's element (`web/packages/workspace-app/src/state/slidePreview.ts` 115, appended to `<body>`): the page holds four `.md-slide-preview-content` elements and the check reads slide 1's, so slide 2's assertion passes on slide 1's content and slide 3's fails. Measured alone at the integrated tip `77639d404` in a two-CPU guest: red 56 of 60 runs; with one binary and one bundle under Puppeteer 24.43.1 and under 25.15.0, red 19 of 20 each, so the suite's Puppeteer stage is not the cause. The four green runs were not probed; a green is consistent with thumbnails not yet rendered at the read. In whole suite runs the check was green once each at the base, at stage 1 and at stage 4's rerun; how a whole run's page differs is not established. The review seat's loop, the A/B run and its probe are `dev/v0109-team/evidence/Review109/c103/` (`loop-1.log`, `ab-1.log`, `probe-103.mjs`).

## Desired contract

The check reads the overlay's content only: every content read in `103-slide-blank-band.mjs` is scoped to `.md-slide-preview .md-slide-preview-content`, and each slide's assertion names that slide's heading text, so a thumbnail rendered beside the overlay can neither satisfy nor fail it.

## What to do

1. Scope every content read in the check to the overlay and assert each slide's heading text.
2. Red first is the check as it stands: alone at the parent, red at about the measured rate; at the fix, green alone in repeated runs. One mutant, the unscoped selector restored, red.
3. Grep `scripts/e2e/browser-smoke/` for other unscoped readers of `.md-slide-preview-content`, beside a positive control (the check's own line before the fix), and scope any found the same way.

## Boundaries

`scripts/e2e/browser-smoke/checks/103-slide-blank-band.mjs` and, only if a shared helper reads the class, `scripts/e2e/browser-smoke/lib/`. Not changed: the slide preview, the Outline's thumbnails, the other checks.

## Acceptance

1. Check 103 alone green in repeated runs at the commit and red alone at the parent at about the measured rate, with the commands, the counts and the log paths recorded here.
2. The unscoped-selector mutant red, recorded here.
3. The grep for other readers of the class, with its control, recorded here.
4. The whole browser suite's every-check-alone acceptance at the freeze runs with this row landed.
