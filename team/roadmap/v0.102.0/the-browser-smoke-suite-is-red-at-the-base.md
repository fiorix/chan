# The browser smoke suite is red before any change

Status: raised for a decision on 2026-10-03 by the builder of the PDF export's range, who ran the whole suite at the range's base and at its tip; the owner has not ruled on it. Run in headless Chrome 154 in the build guest. Ruled on 2026-10-03: see Owner ruling.

## Owner ruling

On 2026-10-03 the owner ruled, as the lead recommended: a diagnosis first, each failing check run alone and in its position in the suite; a repair is ruled after it. The item is accepted for the diagnosis alone.

## What was seen

`scripts/e2e/browser-smoke` run whole fails 18 of its 47 checks at `e11043bb1`, a commit of the v0.102.0 integration branch before the PDF range, and 19 of 47 at that range's tip. Fifteen fail identically at both. The PDF inspector's check is among them, in suite position only: its failure screenshot shows the pane in the middle of a side flip that an earlier check left running, which the suite's README names as a known cause; run alone it passes. One check, the launcher's pane flip, fails alone at both commits. Three differ between the two runs, in both directions, by what the checks before them leave. The failing checks are terminals, the launcher, settings, the graph lens, large files, the video inspector and the cs pane layout; none was diagnosed.

No gate runs this suite, and the build guest had no Chrome until that range's order installed it, so nothing had shown it.

## Desired contract

Not written yet. The README's own rule is that a check passes alone and in any suite position; a suite that is red before any change cannot show what a change broke.

## What to do

Rule whether the suite is repaired in this version. A first order would be a diagnosis: each failing check run alone and in suite position, sorted into a check that leaves state behind, a check that depends on one, and a product fault.

## Boundaries

`scripts/e2e/browser-smoke/**`. A product fault a check uncovers gets an item of its own.

## Acceptance

1. The ruling is recorded.
2. If it is repaired: the whole suite is green at one named commit in the build guest, each check passes alone, and the README says how it is run.
