# Check 173 reads the current slide before a key's effect lands

Status: shipped in [v0.109.0](../../release/release-v0.109.0.md).

Record before the release: built on 2026-10-21 on the seat's branch; the section Built 2026-10-21 holds the evidence; it closes at the GA as shipped.

## What was seen

`scripts/e2e/browser-smoke/checks/173-editor-floating-outline.mjs` 121 to 124 presses `End` and `Home` on a focused thumbnail and reads the current slide at once (`assert.equal(await selected(), 'Slide 10')`, then `'Slide 1'`) with no wait, while the check's own `select()` (50 to 53) waits for the clicked slide to become current. The read sees the previous slide: `'Slide 5'` for `'Slide 10'` and `'Slide 10'` for `'Slide 1'`. The review seat saw this shape at the version's base and at the integrated tip alone (`dev/v0109-team/evidence/Review109/c173/`, shape B), beside the product defect of the Outline's bottom rule, which is its own row.

## Desired contract

Every read of the current slide after a key or a click waits for the expected slide, as `select()` does, so the check fails only when the page never reaches it.

## What to do

Replace the two unwaited reads with a wait on the expected current slide, through the same helper `select()` uses, and read the rest of the check for other reads of page state that follow an input with no wait. Red first is the check as it stands at the parent, alone, at the review seat's rate; a mutant that drops the wait after `End` red.

## Boundaries

`scripts/e2e/browser-smoke/checks/173-editor-floating-outline.mjs`. Not changed: the product, the other checks.

## Acceptance

1. The shape B red absent from repeated runs alone at the commit (the product row's shape A may remain until it lands, and is counted apart), the mutant red, with the commands, counts and logs recorded here.
2. The whole browser suite's every-check-alone acceptance at the freeze runs with this row and the product row landed.

## Built 2026-10-21

The check uses one `waitForSelected(number)` helper for clicked thumbnails and the End and Home keys. It waits until `.slide-thumb[aria-current="true"]` names the expected slide before continuing. When the wait ends without the expected slide, the error names the expected slide and the one the page shows. The other current-slide observation after the mouse wheel already waits for Slide 10; the Preview counter and edited thumbnail also have property-specific waits. No product file or other check changed.

The parent was `beacf5a9feb9992bebba9df8dea3f2e2f7ba6380` in `chan-v0109-hygiene` at two CPUs with Puppeteer 25.15.0 installed by strict `npm ci`. The first ten solo runs were all green; the next ten had eight green, one shape B red at the immediate End read (Slide 5 instead of Slide 10, run 6), and one shape A red at the clicked-thumbnail wait (run 10). All twenty selected exactly check 173, with no skip or invalid result. The two sets and their `run.log`, `run.status`, `results.json`, identity and summary files are under `dev/v0109-team/evidence/Hygiene109/bcs173/baseline-10/` and `baseline-10b/`; both launchers exited 0. The parent showed shape B once and shape A once in twenty runs. The review seat's placement saw shape B in 3 and shape A in 4 of its 20 runs over the base and three integrated tips (12 runs of the check alone, 8 of a probe copy), in its own guest with each tip's own installs; the rates come from different guests, sessions and trees and are not compared.

The fixed guest overlay matched the owning worktree's check file by SHA-256 `c356b1b7d6e14d5ae41d54e717c706cfb9fa2d02847bbaf50c9791e1432116d4`; strict `npm ci` used Puppeteer 25.15.0, `node --check` passed, and ten solo runs passed with no skip or invalid result. The logs, results, and identity are under `dev/v0109-team/evidence/Hygiene109/bcs173/fix-overlay/`, with `fix-overlay.launch.status` exit 0. Shape A remains a separate product row; it did not occur in these ten fixed runs.

One mutant replaced only the wait after End with the old immediate current-slide assertion. Its first bounded thirty-run set gave one shape A red and no shape B red, so that set did not prove the guard; its launcher exited 1 and the attempt is retained. The second set reached shape B on run 29, reading Slide 5 instead of Slide 10 at the mutated assertion, with three separate shape A timeouts, twenty-five greens and no invalid result; its launcher exited 0. Both mutant sets, the replacement diff, status, and per-run logs are under `dev/v0109-team/evidence/Hygiene109/bcs173/end-wait-mutant/` and `end-wait-mutant-2/`. The second run's exact red is `end-wait-mutant-2/run-29/results.json`.

At code commit `f8c74ea6df583da7d6efd86a765d3cad6996516c`, the clean private checkout matched the clean owning worktree. Strict `npm ci` installed Puppeteer 25.15.0; `node --check` for check 173, `make e2e-check`, and `git diff --check` exited 0 in the guest (`dev/v0109-team/evidence/Hygiene109/bcs173/commit-gate/` and `sync-gate.launch.log`). Ten further solo runs at that commit gave seven green and three shape A timeouts at `select()` (runs 3, 7 and 8), with no shape B red, skip or invalid verdict (`committed-10/`). The ten-run launcher exited 0 because it validates each recorded outcome, including a real product red; it does not claim all ten passed. The product row must land before the freeze's whole-suite and every-check-alone acceptance can be green.

Ten solo runs of check 173 with this commit's file at the integrated tip `a25c1c260` in the integration guest, after the whole suite there, were all green, with no shape A timeout (`dev/v0109-team/evidence/Lead109/int/proof-chain-1/c173-fold.log`).

Acceptance 1 is met by construction and by the mutant: the check reads the current slide only through `waitForSelected`, so the immediate read that gave shape B is gone; the End-wait mutant restored it and reached shape B once in 59 attempts at the mutated line; twenty runs with the wait (ten at the overlay, ten at the code commit) gave no shape B. The review seat's probe read the current slide in the End key's own task as the previous slide in 7 of 7 runs, the new slide a microtask later, and the previous slide again for one frame in 3 of 8, with the wait reaching Slide 10 in 8 of 8 (`dev/v0109-team/evidence/Review109/bcs173/probe-1.log`).

Acceptance 2, the freeze's whole suite and every check alone with the product row landed, is the lead's.
