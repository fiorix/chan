# Check 173 reads the current slide before a key's effect lands

Status: raised for v0.109.0 on 2026-10-21 by the lead, from the review seat's placement of the check's red; closes in the round.

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
