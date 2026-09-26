# A management mount accepted just before stop can publish after the devserver's last shutdown sweep

Status: raised during v0.101.0 on 2026-09-26 from the independent review of the root locks lane (`dev/v0101-tasks/reviews/review-rlock-2.md`, finding 7), which says the gap existed before that branch. It follows from [one-root-blocks-every-other-mount](one-root-blocks-every-other-mount.md), whose lane added the second sweep for discovery registrations. A source reading against the root locks lane at `3746c268f`, which had not landed on the integration branch when this was raised, so every line cited is as it is at that sha; read in code, not reproduced.

## What was seen

When the devserver stops, `graceful_serve` hands axum a graceful-shutdown future and races it against a 10 s grace (`crates/chan-server/src/signal.rs:85-89`, `:110-134`); on unix the deadline arm returns (`:151-156`). axum 0.8.9, the version the lane's `Cargo.lock` pins, runs each connection in a task of its own (`axum-0.8.9/src/serve/mod.rs:389`), so returning from `serve` does not cancel a request that is still running. The devserver then goes on to `shut_down_hosted` (`crates/chan-server/src/devserver.rs:2175-2194`), which stops the discovery listener, drains the registrations it had accepted beside the tenants' shutdown, and sweeps the host twice (`:2225-2240`). `WorkspaceHost::shutdown_all` drains the runtime map and sets nothing that refuses a later publication (`crates/chan-library/src/host.rs:3332-3353`).

The review's scenario: a management mount started just before stop, through `POST /api/devserver/workspaces`, its per-prefix on route (`devserver.rs:2377-2385`), or the launcher's add or on, is still inside its 60 s bound (`WORKSPACE_MOUNT_TIMEOUT`, `:301`) when the second sweep runs. It publishes after that sweep, and its tenant never gets the host's graceful shutdown; it goes down with the process. For discovery registrations the drain does hold, and nothing publishes after it. On Windows the grace deadline exits the process instead (`signal.rs:146-149`), so there the mount dies with it at 10 s.

## Desired contract

No tenant publishes after the devserver's last shutdown sweep: a management mount still running when shutdown starts either finishes before that sweep, within a stated bound, or is refused at publication and shuts its own runtime down.

## What to do

The review gives no fix. Two shapes, as suggestions. The host could refuse publication once shutdown has begun, with a flag the first `shutdown_all` sets and publication checks where it already checks prefix and root under the write lock, so the late runtime shuts down the way a runtime that loses a publication race does (`crates/chan-library/design.md:38`); that covers every entry point at once. Or the devserver could track its in-flight management mounts and wait for or cancel them before the second sweep, as it does for discovery registrations (`REGISTRATION_SHUTDOWN_DRAIN`, `devserver.rs:2209-2215`). Red first: start a management mount whose open the `paths::root_stall` seam holds, stop the devserver, release the root after the second sweep, and show that no tenant is left mounted without a shutdown; today one is.

## Boundaries

`crates/chan-library/src/host.rs` (`shutdown_all` and the publication check) or `crates/chan-server/src/devserver.rs` (`shut_down_hosted` and the management mount routes), depending on the shape chosen, and `crates/chan-server/src/signal.rs` only if the serve loop's return changes.
