# A restored root that does not answer keeps every restored tenant at 503 until its bound ends

Status: accepted for v0.102.0 by the owner on 2026-10-02, when the owner ruled that v0.101.0 ships the startup restore's cap alone. Split from [one-hung-root-holds-up-the-whole-restore](../v0.101.0/one-hung-root-holds-up-the-whole-restore.md), whose ruling of 2026-09-29 had built this gate together with the cap. Taken from that item's record of the cap as built; nothing was run for this one.

## Owner ruling

Accepted on 2026-10-02 for v0.102.0, in the runtime lane. The plan comes first, as the ruling of 2026-09-29 asked of the gate: it says what READY means with a root still pending, and what becomes of the parked terminals of a root that has not mounted when the fdstore apply runs. Whether the desktop's boot restore is built in the same order is not ruled.

## What was seen

A starting devserver restores up to four workspaces at once (`restore_prepared_workspaces` and `STARTUP_RESTORE_CONCURRENCY`, `crates/chan-server/src/devserver.rs`), so the rows behind a root that does not answer are mounted while it is held. They do not serve: a workspace's routes answer 503 until the whole restore has ended and the restored terminals are adopted (`gate_tenant_during_startup`), so one such root still delays every tenant, and the ready notice, by up to its bound of sixty seconds, and a row queued behind four such roots still waits for one of them to end. The fdstore apply runs after the whole restore because an inherited terminal needs its tenant mounted. One of the cap's tests pins this as it is: a held row keeps the fdstore apply, `Ready` and the gate waiting.

## Desired contract

A restored root that does not answer delays its own row and no other: the other rows' tenants serve once their own restore and their inherited terminals are ready, and READY follows within a bound that does not grow with the number of roots that do not answer.

## What to do

The plan first. Then red first: a test with two rows that are on, the first held by the `paths::root_stall` seam, that shows the second tenant answering before the first attempt's bound expires; today it answers 503 until then. Opening a tenant before the whole restore has ended splits the fdstore apply by root, and the pin that holds the gate waiting behind a held row changes with it.

## Boundaries

`crates/chan-server/src/devserver.rs`: the startup phases, `gate_tenant_during_startup` and the fdstore apply. The cap stays as it is built. The desktop's boot restore was not read for this item.

## Acceptance

1. The plan is recorded, and says what READY means with a root pending and what becomes of that root's parked terminals.
2. With one root held, a second restored tenant answers before the held attempt's bound ends, by a test that was red first.
3. The delay of READY does not grow with the number of held roots.
