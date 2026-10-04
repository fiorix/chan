# The browser smoke suite is red before any change

Status: raised for a decision on 2026-10-03 by the builder of the PDF export's range, who ran the whole suite at the range's base and at its tip; the owner has not ruled on it. Run in headless Chrome 154 in the build guest. Ruled on 2026-10-03: see Owner ruling. Ruled by the owner on 2026-10-04: the repair goes as the diagnosis proposes, in two builds (a browser context of its own for each check and flips waited out by observation first; the stale contracts and the terminal's attachment second), with check 107 on an item of its own.

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

## What the diagnosis found

Run on 2026-10-03 and 2026-10-04 in the build guest at one head of the integration branch, by a builder who committed nothing; every verdict rests on a run. The whole suite once: 47 checks ran, 28 passed and 19 failed (18 at the head this item was raised on: `15-launcher-flip-pane` and `90-launcher-gateways` fail now and `123-hybrid-nav-stale` passes). Each failing check then ran alone twice, from a fresh server and a fresh profile, and those that pass alone ran behind the checks they follow.

- Seven hold a contract or a selector the product has since changed: 105 (a settings section the rail does not have), 121 (a submit to a shell that now exits 0), 21 (a cached 206 answered to a fetch that asks no range), 59 (a buffered read past the 2 MiB bound), 62 (a fixture expected under the home directory), 80 (the words of a refused open), 95 (a dialog looked up by a label it does not carry).
- Three fail alone, always or now and then, on a timing of their own around a pane's flip or a click: 15, 90, 120.
- Six pass alone and fail behind other checks, on state those leave or on a flip still under way: 20, 94, 99, 106, 110, 112. For 99 and 110 the check or the set of checks they depend on is not named yet.
- Two assert a terminal's DOM before the page has attached the terminal: 93 and 97. Their later assertions cannot be classed until that is repaired.
- One is not resolved: 107, where two views of one window and a third window do not converge on a renamed terminal in a fresh run. A gap in the check's readiness or a fault of the product: no run tells them apart yet.

No fault is assigned to the product on a run. The repair the diagnosis proposes: a reset between checks in the runner (the active view, the tabs, the settings and launcher overlays, the pane's side); 106 and 112 open the surfaces they need; the flip checks wait for an observed start and end; the seven stale contracts are brought to what the product does; 93 and 97 wait for the page's attachment, then their later assertions and 94 run again; 107 gets an investigation of its own before a repair is named. The repair waits for the owner's ruling, as this item's ruling says.
