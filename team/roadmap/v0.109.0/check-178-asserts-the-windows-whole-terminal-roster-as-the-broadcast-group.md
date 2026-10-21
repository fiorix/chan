# Check 178 asserts the menu's whole terminal list as the broadcast group

Status: raised for v0.109.0 on 2026-10-21 by the lead, from the whole browser suite at the integrated tip; closes in the round.

## What was seen

`scripts/e2e/browser-smoke/checks/178-typed-broadcast.mjs` opens the target terminal's tab menu, chooses Select All for the broadcast group, reads every `.target-row` of the menu bubble and asserts `details.group.length === 2 && details.group.every((row) => row.checked)` ("both terminals are in the group"). Alone, the window's roster holds the check's two terminals and the assertion holds; in the whole suite at `4e118d262` the menu also listed four same-group terminals earlier checks left in other windows of the tenant (`Terminal-1`, `cli-reload-164-exited`, `Status150xtermS`, `Status150ghosttyS`), under the menu's other-windows rows and unchecked when the check read the rows, since Select All flips them through the server; the list had six rows, and the check failed on that assertion while its own two rows were checked (`dev/v0109-team/evidence/Lead109/int/browser-int3/suite.log`, the typed-broadcast check). The check was green alone three times at that tip (`dev/v0109-team/evidence/Lead109/int/proof-chain-int3/c178-int3.log`) and, at its own commit, beside check 137. Nothing in the product is wrong: the group holds the two terminals the check made, and Select All is group-wide across windows by design.

## Desired contract

Check 178 passes alone and in any whole-suite order, asserting the group it made: its two terminals checked, whatever other windows' terminals the menu lists.

## What to do

Build: the assertion reads the rows whose name is the check's own (`TypedBroadcastTarget178`, `TypedBroadcastSource178`), asserts both are checked, and records the full list in its details; it does not count the roster. Red first: the check run after checks that leave terminals in the roster (for example 150 and 164, then 178, in one runner invocation) fails at the parent on that assertion and passes at the commit; alone it passes at both.

## Boundaries

`scripts/e2e/browser-smoke/checks/178-typed-broadcast.mjs` alone. Not changed: the product, the suite's runner, the other checks.

## Acceptance

1. The ordered run red at the parent on the roster assertion and green at the commit; alone green at the commit; the commands and logs recorded here.
2. `make e2e-check` green at the commit.
