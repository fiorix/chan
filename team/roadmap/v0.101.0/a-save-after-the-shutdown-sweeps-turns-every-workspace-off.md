# A save after the shutdown sweeps turns every other workspace off

Status: ratified for v0.101.0 by the owner on 2026-09-29, after it had landed; raised during v0.101.0 on 2026-09-26 while the fix for [a-late-http-mount-escapes-the-shutdown-sweep](a-late-http-mount-escapes-the-shutdown-sweep.md) was built, and reproduced by a probe before the fix; fixed with that item and landed with it. It was not put to the owner when it was raised, since it landed with its fix.

## What was seen

`persist_state_with_mounted_snapshot_locked` in `crates/chan-server/src/devserver.rs` reconciles the desired-state overlay against the host's mounted prefixes and turns every `Mounted` record the host does not serve off at a newer generation, taking it for a close made out of band. Once the devserver's shutdown sweeps have taken every tenant out of the host, any save reads every workspace that was on that way. A management mount or a drained discovery registration that settled between or after the sweeps saved, and so wrote every other workspace desired-off; the next start restored none of them. The probe mounted one root before the stop and released a late mount of another after both sweeps: the overlay read the first root on at generation 1 before and after the sweeps, and on at generation 1 for the late root but off at generation 2 for the first once the late mount settled. The desktop's `persist_workspaces` had the same shape: a `chan close` handed off during the quit drain wrote an empty on-set.

## Desired contract

Once a shutdown has begun, no save rewrites the desired-state overlay: it holds the state the stop found, so the next start restores the same on-set. A save that carries something else durable (a rotated devserver token) still writes that.

## What shipped

Landed on 2026-09-27. On the devserver, `DevserverState.shutting_down` is set at the top of `shut_down_hosted`, before its first sweep. From then on a save does not read a `Mounted` record whose prefix the host no longer serves as a close made out of band: it keeps that record's desired state instead of turning it off. Every other change still saves, so an off or a registration whose save lands during the stop records its intent, and the devserver config is written on every save as before. On the desktop, `persist_workspaces` writes nothing once `shutdown_started` is set; `begin_normal_shutdown` sets it and writes the stop's own snapshot through `snapshot_workspaces` before it spawns the drain, and a close handed off during the drain records that workspace off through the host and changes no other row.

The devserver half narrows the Desired contract above: once a shutdown has begun, a save still writes a change of desired state that lands during the stop, and holds the state the stop found for every workspace the sweeps took down. Pinned: a mount settling after the sweeps leaves the overlay as the stop found it; an off saved after shutdown began reads off beside a workspace that stays on; a registration saved after shutdown began reads on; and on the desktop, a close after the drain leaves the other workspace on. The registration pin sets the flag with the startup coordinator ready; in the devserver's own stop the coordinator refuses a new mount from the shutdown signal on, before the flag is set, so a registration that begins after the flag is not reachable there: [the-devserver-stop-refuses-mounts-before-the-host](the-devserver-stop-refuses-mounts-before-the-host.md). No test rotates the token during a stop.

## Boundaries

`crates/chan-server/src/devserver.rs` (the shutdown path and the locked persist) and `desktop/src-tauri/src/main.rs` (`persist_workspaces`, `begin_normal_shutdown`); landed with [a-late-http-mount-escapes-the-shutdown-sweep](a-late-http-mount-escapes-the-shutdown-sweep.md).
