# A timed-out devserver mount force-closes a tenant it did not open

Status: shipped in [v0.100.0](../../release/release-v0.100.0.md): A devserver mount attempt whose bound expires compensates only for what it may have created, so a tenant something else mounted keeps its sessions and its row.

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

## What the second check was pinning

Nothing. The host inserts the tenant, drops the guard, notifies and returns inside a single poll with no await between, and the registration entry point hands that value back as a tail await with nothing after it, so a mount that published always completes in the poll that published and lands in the success arm. Reaching the timeout arm therefore proves this attempt published nothing, and the compensation the second check asks to keep never had a case to fire on. The test that stands in its place pins what is still owed when nothing is serving the root, which is the question that does have two answers.

That property is what makes the fix safe, so it is written into `crates/chan-server/design.md` rather than left to be rediscovered: an await introduced between the insert and the return would put the case back.

## What the third check can and cannot buy

Its first half is met: a mounted root outranks a failed record when the row is built, so a tenant that is serving with live terminals no longer reports `error` over the top of it, and the attempt's own failure still reaches whoever asked for the mount.

Its second half cannot be met as written, and the reason is the wire rather than the fix. `on` means "this devserver serves this tenant", not "this workspace is running". `library_off_entry` in `crates/chan-server/src/devserver.rs` builds the row for any library workspace the devserver is not serving with `on: false` and no token, and `WorkspaceHost::workspace_status` reports a mounted root as running. So `running, on: false` is the row that root carries with or without a failed attempt, and a devserver cannot honestly claim to serve a tenant it does not serve: the token a claim would advertise is cleared on failure, and making the claim true means adopting another caller's mount.

The residual is therefore one row up, in what the launcher does with those two fields: it renders `on: false` as the word "Off" beside a status pill reading running. That is a vocabulary question for the whole surface rather than a defect of this item, and it is raised for the next version.

## What the macOS runs showed

The two tests that pin this item never passed on macOS. Their mount fixtures decide which build to park by comparing a raw temp path with `Workspace::root()`, and the registry stores the canonical root. On Linux `/tmp` canonicalizes to itself, so the two agree. On macOS the temp directory is `/var/folders/...` and `/var` is a symlink to `/private/var`, so they differ. The park never fired, the unbounded rendezvous on the `entered` channel waited forever, and `make ci-macos` ran to GitHub's 360-minute default on every `ci.yml` run after the item landed; the release workflow's macOS validation stalled in the same step.

`3a9844d46` stores the fixture paths in the registry's canonical form and bounds both rendezvous at ten seconds, so a park that misses fails the test with a named panic instead of hanging the job. `551a59fff` gives both macOS jobs `timeout-minutes: 90`. The defect reproduces on Linux with `TMPDIR` on a symlink: both tests hang there before the fix. With only the canonicalization reverted and the bound kept, they fail in about twelve seconds.
