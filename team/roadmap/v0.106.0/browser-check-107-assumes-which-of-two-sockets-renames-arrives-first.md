# Browser check 107 assumes which of two sockets' renames arrives first

Status: raised by the hygiene seat on 2026-10-13 from a red in its whole browser run at two CPUs (`followups/followup-Hygiene106-Lead106-37.md` in the round's bus); written down the same day by the lead as a row of its own; owner the frontend seat; the repair ordered in the v0.106.0 round

## What was seen

In the whole browser suite at the integration commit `ea4b04f18`, in a guest capped at two CPUs on a host whose I/O was contended, check 107 failed at its first collision assertion: browser A's terminal settled as the suffixed name and browser C's as the unsuffixed one, where the check requires the reverse (`evidence/Hygiene106/stalls-2cpu-1/whole-2.log`). The check prepares a rename on two pages' own WebSocket connections, sends A's frame and then C's without awaiting either acknowledgement, by its own comment ("The registry settles the shared collision"), and then asserts that A holds the collision name and C the name with `-2` (`scripts/e2e/browser-smoke/checks/107-terminal-rename-inventory.mjs` 394 to 424). Sending A's frame first in the driver does not order the two frames' arrival at the server, which reads each connection on its own task. The check has made this assumption since it was written on 2026-10-04; no product line is implicated by the reading.

Not established: how often the order flips, at two CPUs or at four; that the product's own settlement is right in the flipped order beyond what the failed run's roster shows (two distinct names, one suffixed).

## Desired contract

The check asserts what the registry guarantees when two renames to one name race: both settle, the names are distinct, one is the collision name and the other carries the suffix; it does not assert which socket won. Where the check needs a known winner for its later steps, it reads the winner from the settled names.

## What to do

Repair the check, test only: accept either winner at the collision assertion, assert the pair of names as a set, and carry the settled names forward as the check already does. Show the repaired check red when the registry settles both to one name or leaves one unsettled (a constructed stand-in or a product mutant in a guest), and green alone several times with the order forced each way if the driver can force it, or with both orders observed.

## Boundaries

`scripts/e2e/browser-smoke/checks/107-terminal-rename-inventory.mjs` alone. Not changed: the registry's collision rule and the rename route.

## Acceptance

1. The check's collision assertion holds for either arrival order and fails when the two names are not distinct or one rename is not settled; shown able to fail.
2. The check green alone at the commit in the owning guest, with each observed order named.
