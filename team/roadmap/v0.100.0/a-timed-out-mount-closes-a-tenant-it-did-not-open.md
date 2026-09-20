# A timed-out devserver mount force-closes a tenant it did not open

Status: accepted for v0.100.0 by the owner on 2026-09-20. Raised from the independent review of the v0.99.0 degraded-root change, carried over from that release's follow-ups. A source reading; nothing was run to reproduce it.

## What was seen

The devserver bounds every mount attempt. `execute_mount_attempt` in `crates/chan-server/src/devserver.rs` wraps `open_or_get_registered_workspace` in `time_bound_mount` (60 seconds), and when the bound expires its `MountTimedOut` arm calls `close_workspace(&attempt.prefix, true)` to compensate for a tenant that may have been published just before the cancellation, then records the row as failed.

That compensation does not ask whether this attempt created the tenant. When the root was already mounted, the forced close lands on a live tenant: its terminals are killed, dirty buffers are dropped, and the row reads `error` with `on: false`.

Two ways reach it. Before v0.99.0, an attempt for an already-mounted root could wait more than 60 seconds on the registration lock. v0.99.0 added a second: the already-mounted early return in `crates/chan-library/src/host.rs` now awaits a blocking revalidation of the root, so a root that answers slowly can carry the attempt past the deadline. Both need a root the host has mounted without a mounted devserver record, which is what a launcher add on a devserver produces, so the window is narrow. The outcome is the harshest the product has: it ends terminal sessions nobody asked to end.

## Desired contract

A timed-out attempt compensates only for what it may have created. If the root was mounted before the bounded call began, the timeout leaves the tenant alone and reports the attempt as timed out.

## Boundaries

`crates/chan-server/src/devserver.rs`: the timeout arm of `execute_mount_attempt`, and the identical forced close in `cancel_mount_attempt`, which deserves the same question. The success path's `CloseStale` close earlier in `execute_mount_attempt` is not the same case: that attempt did publish the tenant it closes. The reviewer's suggested shape is to read `is_root_mounted(&attempt.root)` before the bounded call and compensate only when it was false; that suggestion is unverified. A timeout inside the revalidation does not fix it, because any await after the deadline trips the outer timer.

## Acceptance

1. A test mounts a workspace, makes a second attempt for the same root exceed the bound through a seam rather than a sleep (`execute_mount_attempt` already takes its bound as a parameter, so the seam exists), and asserts the tenant, its prefix and a live terminal session survive.
2. A test keeps the existing compensation: an attempt that did publish a tenant and then timed out still closes it.
3. The failed-row record says the attempt timed out and does not claim the workspace is off.
