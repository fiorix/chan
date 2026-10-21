# Check 103 reads the Outline's first slide thumbnail instead of the overlay

Status: built on 2026-10-21 on the seat's branch; the section Built 2026-10-21 holds the evidence; it closes at the GA as shipped.

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

## Built 2026-10-21

The check waits for `.md-slide-preview .md-slide-preview-content` and reads only that overlay descendant. It asserts the expected first heading text on all three slides, along with the heading tag and spacer counts, so the Outline's first-slide thumbnail cannot stand in for any overlay slide. No slide preview or thumbnail product source changed.

At the parent `277807203ab92b067f096fe8a715f515473a8b16` in `chan-v0109-hygiene`, ten `SMOKE_ONLY=103- SMOKE_SKIP_BUILD=1` runs selected exactly one check each: one red and nine green, with no skips or invalid verdicts. The red reported slide 3 as `{"firstTag":"H1","firstText":"First slide","spacers":0}`. The rate is not established. In the review seat's guest, with one suite install, check 103 alone was red 14 of 20 on the base's web bundle and 1 of 20 on the web dependency refresh's bundle under one binary built at the base. Interleaved run by run on the refreshed bundle, it was 7 of 15 under the binary built at `77639d404` and 3 of 15 under the base binary, where that bundle and binary had been red 56 of 60 two hours earlier. Every red, there and here, read slide 1's thumbnail at slide 3; neither the web lockfile nor the binary holds the rate, which moves between sessions and guests. The scoped check was green in every arm there: 0 of 10, 0 of 20 and 0 of 15, the last interleaved with the 7 of 15 (`dev/v0109-team/evidence/Review109/bcs103/`). Acceptance 1's "at about the measured rate" is met by the red's signature and that paired arm, not by a rate. The guest used Puppeteer 25.15.0 and the binary SHA-256 `e0fb34ff03b6d6b2dd25eb65fcf368e18d73e9398b22cbc8afa5cb91bc81bdb4`; that binary was built at `d360ba7e2` and the served bundle was the base's `web/` (svelte 5.56.4), one of the variables the record above shows does not hold the rate. The ten `run-*/run.log`, `run.status` and `results.json` files, `summary.status` and `identity.txt` are under `dev/v0109-team/evidence/Hygiene109/bcs103/baseline-10/`, exported as `baseline-10.tar.gz`.

The repaired check's uncommitted guest overlay passed once. One mutant restored only the content read's unscoped selector while retaining the scoped overlay wait and the heading assertions; attempt 7 failed on slide 2 with `firstText: "First slide"`, while attempts 1 to 6 were green. `dev/v0109-team/evidence/Hygiene109/bcs103/probe-and-mutant/` holds the fixed and mutant logs, statuses and results, and `probe-and-mutant.tar.gz` exports the guest record. The guest's patch SHA-256 after restoring the mutant matched the worktree's explicit patch (`38fd229492f233210355c84fd908686f6ac23e245862ab6fa99fa8af8b18e2da`).

An uncut `git grep -n` for `.md-slide-preview-content` by object, at the parent and at the tip (`selector-search-{parent,tip}.txt`), found the check's two unscoped lines as positive controls and one already scoped thumbnail read in check 173. After the edit, all three reads or waits have an ancestor selector: check 103 names the overlay, and check 173 names `.slide-miniature`. No shared helper reads this class.

At committed tip `beacf5a9feb9992bebba9df8dea3f2e2f7ba6380`, `node --check` and the guest's clean-checkout and `git show --check` guards passed; ten solo `SMOKE_ONLY=103- SMOKE_SKIP_BUILD=1` runs passed with one selected check and zero skips each. The full browser suite then passed in `chan-v0109-hygiene` with Puppeteer 25.15.0, 92 checks, zero failures, zero skips and runner exit 0; check 103 and check 173 both passed in that whole run. An independent reader passed six constructed failure controls, then matched the result's 92 files exactly to the suite inventory with all `ok: true` and `skipped: false`. The complete guest output is exported as `dev/v0109-team/evidence/Hygiene109/bcs103/whole-commit.tar.gz` (SHA-256 `96a5c6ffc9e67a062c83d60d4c7258227ce2cc382334559cac91cca9ff67a485`); `whole-commit/` holds the log, status, summary, result JSON and identity, while `committed-solos/` holds each solo log, status and result. The exported `results.json` matches the guest file at SHA-256 `624e05967acfd1c011aba185c397fff678d13f5b310b430a0bf273b11c261230`. The freeze's every-check-alone run remains a separate integration acceptance.

At the integrated tip `a25c1c260` in the integration guest, after the whole browser suite there, the parent's check 103 and this one ran interleaved fifteen times each on the tip's own binary and bundle (`dev/v0109-team/evidence/Lead109/int/proof-chain-1/b6.log`): the parent's check was green 15 of 15 and this one 15 of 15, so that session shows no contrast of its own, and the proof rests on the paired arm above, the mutant and the signature.
