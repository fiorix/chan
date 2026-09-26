# One hung root holds up every other restored workspace and the devserver's READY

Status: raised during v0.101.0 on 2026-09-26 from the independent review of the root locks lane (`dev/v0101-tasks/reviews/review-rlock-2.md`, finding 4), which the lane's report discloses as "restore attempts run one after another" (`dev/v0101-tasks/report-rlock-2.md`, part C). It follows from [one-root-blocks-every-other-mount](one-root-blocks-every-other-mount.md). A source reading against the root locks lane at `3746c268f`, which had not landed on the integration branch when this was raised, so every line cited is as it is at that sha; read in code, not reproduced.

## What was seen

At startup the devserver inserts a record for every persisted row, `starting` for each one desired on (`prepare_restore_rows`, `crates/chan-server/src/devserver.rs:1642-1681`, and `WorkspaceRecord::prepared`, `:394-413`), and then restores the desired-on rows in `restore_prepared_workspaces` (`:1731-1781`) one attempt after another. Each attempt is bounded by the mount timeout (`:1758-1761`), 60 s (`WORKSPACE_MOUNT_TIMEOUT`, `:301`), inside an 8-minute budget for the whole restore (`STARTUP_RESTORE_TIMEOUT`, `:352`). The startup path awaits the restore (`:2145-2146`), then applies the fdstore handover, advances to `Ready` (`:2151-2159`) and notifies systemd (`:2163-2165`). Until then `gate_tenant_during_startup` answers 503 for every mounted tenant's path (`:2437-2455`; `tenant_routes_ready` is `phase == Ready`, `:657-659`), including the tenants already restored; the management routes answer meanwhile.

The review's scenario: one desired-on root whose filesystem hangs makes every restored workspace answer 503 for up to 60 s, and READY waits with it. An `on` for a row still queued finds `begin_on` refusing a second attempt for a row that is desired on and `starting` (`:421-426`, called from `begin_registered_mount` at `:977-979`), so it returns at once while the row stays `starting`. With eight hung roots ahead of it, eight bounds of 60 s spend the whole budget, and every later row, healthy or not, fails with "startup restore exceeded 480 seconds" (`:1746-1756`).

The lane's report says why it kept the attempts sequential: running them concurrently is a load decision (workspace opens, indexing and file descriptors at startup) that the round did not take. The review rates it low because it is bounded, where `main` was unbounded.

## Desired contract

A restored root that does not answer delays its own row and no other: the other rows restore, their tenants serve, and READY follows within a bound that does not grow with the number of hung roots.

## What to do

The review offers two shapes: run the attempts concurrently under a cap, or gate each root on its own. The cap is the load decision the lane deferred; a cap of a few attempts keeps the startup load bounded, and one hung root then costs one slot. Gating each root on its own means opening a tenant's routes once its own restore and its inherited terminals are ready rather than at the global `Ready`; the fdstore apply runs after the whole restore because an inherited terminal needs its tenant mounted (`:2151-2158`), so that shape splits the apply per root as well. Red first: a test with two desired-on rows, the first held by the `paths::root_stall` seam, that shows the second tenant answering before the first attempt's bound expires; today it answers 503 until then.

## Boundaries

`crates/chan-server/src/devserver.rs`: `restore_prepared_workspaces`, the startup phases and `gate_tenant_during_startup`, and the fdstore apply if the choice is to gate per root. The desktop's boot restore was not read for this item.
