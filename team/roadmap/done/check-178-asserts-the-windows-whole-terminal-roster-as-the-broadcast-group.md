# Check 178 asserts the menu's whole terminal list as the broadcast group

Status: shipped in [v0.109.0](../../release/release-v0.109.0.md).

Record before the release: built on 2026-10-21 on the seat's branch; the section Built 2026-10-21 holds the evidence; it closes at the GA as shipped.

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

## Built 2026-10-21

Commit `ab3d3c1c487e9423276161d3ace0a6dfba35699b` checks the `TypedBroadcastTarget178 (self)` and `TypedBroadcastSource178` rows by name and requires each to be checked. The assertion does not count other roster rows, and `details.group` keeps the full list for failure evidence. Only check 178 changed; the product, runner and other checks did not.

At parent `95d14a62b9763a7a3a9b23cc7519943d114f3204`, `SMOKE_ONLY=150-,164-,178-` returned raw rc 1: checks 150 and 164 passed, then check 178 failed at the group assertion with its two rows checked and three other rows unchecked (`Status150ghosttyS`, `Status150xtermS`, `cli-reload-164-exited`). The subset's five-row assertion is in `dev/v0109-team/evidence/Hygiene109/bcs178/guest/parent-red-int/assertion.txt`; its result statuses are in `ordered.status` and `green-tip/parent-validate.status` under the same evidence directory. The whole-suite six-row failure, which also includes `Terminal-1`, remains in `dev/v0109-team/evidence/Lead109/int/browser-int3/suite.log`. The first attempt at `4e118d262` returned skip rc 2 before any check because the runner looked for a checkout-local binary while the guest's `CARGO_TARGET_DIR` is `/home/ubuntu/target`; its log and status are retained as `guest/parent-red/ordered.{log,status}`. The corrected run set `CHAN_BIN` to the guest's debug binary.

At the commit, strict browser-suite `npm ci` installed Puppeteer core 25.15.0 (rc 0); the debug binary's SHA-256 was `6e086bc81039c65aabfa5d30463ddea3c21a1e3100e25f06088922f15b9650d0`. The same ordered three-check invocation and check 178 alone each returned rc 0, with three and one selected, unskipped green results respectively; `make e2e-check` returned rc 0. Logs, statuses, parsed results and binary identity are in `dev/v0109-team/evidence/Hygiene109/bcs178/guest/green-tip/`, exported as `guest-evidence.tar.gz` (SHA-256 `400571b0c5005b2ae33d15ab571203c8273e4e14c9d338f577f9357037ca4002`). These runs cover acceptance points 1 and 2; the whole-suite run at the frozen combined commit is the lead's gate.
