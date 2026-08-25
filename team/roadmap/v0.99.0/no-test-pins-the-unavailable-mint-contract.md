# Nothing pins the contract that an unavailable workspace still gets a window

Status: raised for v0.99.0 by the owner, from a decision taken in the v0.98.0 round.

## What was seen

Two v0.98.0 changes meet at one behavior. The devserver's `RegisterWorkspace` handler mounts a workspace and mints exactly one window for it, as one conjunctive success. The flaky-mount fix adds `WorkspaceStatus::Unavailable`, set by a timer that calls `revalidate_root` on each mounted root and marks the row degraded when the root answers `RootUnavailable`.

So a registration can mint a window for a workspace whose root the probe currently classifies `Unavailable`. The round decided it should, and recorded the decision and its reasoning in the serve item. Nothing tests it.

## Why the decision was what it was

Recorded here because an untested contract survives only as long as its rationale is findable. Registration mints regardless of the probe's classification, because refusing would return the user to the prompt with nothing, which is the defect the serve contract exists to fix; because the flaky-mount fix exists to keep a workspace on a flapping mount openable and reporting honestly, so declining to open it inverts that; because `Unavailable` is a sampled, self-clearing overlay, so a refusal keyed to it would make identical commands succeed or fail on probe timing; and because the genuine refusals already exist elsewhere, with a missing window registry declining before the mount and the flock, and a mount failure returning an error before the mint is reached.

## Why it is not already pinned

The state cannot currently be reached from a test. `MountState` lives in a private map in `crates/chan-library/src/host.rs` with no setter, and the only thing that writes `MountState::Unavailable` is the probe, which requires a root that genuinely fails `revalidate_root`. A unit test cannot produce that without a real unreachable mount, and `scripts/e2e/flaky-mount.sh` can, but it needs rclone and FUSE and is a manual harness outside the gate.

Adding a test-only way to force the state is the obvious move and it is a real design decision rather than a test to slip in, which is why it was deferred rather than done: it introduces new surface into a subsystem for the benefit of a different subsystem's test, and where that hook lives determines whether it stays honest.

## Desired contract

The behavior is unchanged: a registration for a mounted but degraded workspace mounts, mints one window, and returns success, and the window and the launcher row are where the degraded state is reported. What this item adds is a test that fails if that changes.

## Boundaries

`crates/chan-library/src/host.rs` for whatever mechanism exposes the state to a test, and the discovery handler's tests in `crates/chan-server/src/devserver.rs`.

Three shapes are worth weighing before one is chosen: a `#[cfg(test)]` setter, which cannot be reached from another crate's tests and therefore does not help `chan-server`; a `pub(crate)` or feature-gated seam, which does but widens the crate's surface; or a fake or trait boundary for the probe, which is the largest change and the only one that also makes the probe's own transitions testable.

That third option is worth real consideration rather than dismissal. The probe currently has no test that exercises a root going away and coming back, so the hook this item needs may be the smaller half of a gap that is already there.

## Acceptance

1. A test drives a mounted workspace into `Unavailable`, sends a registration for it, and asserts the response is a success carrying a prefix and that exactly one window record was minted.
2. A test asserts the refusals that remain refusals: a missing window registry declines before the mount and before the flock, and a mount failure returns an error with no window minted.
3. The mechanism that forces the state is not reachable from a release build, or is confined to a test-only seam that is named as such where it is defined.
4. If the probe seam is chosen, a test also covers a root going unavailable and then becoming reachable again, clearing the degraded mark.
