# Nothing pins the contract that an unavailable workspace still gets a window

Status: shipped in [v0.100.0](../../release/release-v0.100.0.md): A test now pins that a registration for a mounted but degraded workspace mounts, mints one window and succeeds, with the degraded state on the window and the launcher row.

## What was seen

Two v0.98.0 changes meet at one behavior. The devserver's `RegisterWorkspace` handler mounts a workspace and mints exactly one window for it, as one conjunctive success. The flaky-mount fix adds `WorkspaceStatus::Unavailable`, set by a timer that calls `revalidate_root` on each mounted root and marks the row degraded when the root answers `RootUnavailable`.

So a registration can mint a window for a workspace whose root the probe currently classifies `Unavailable`. The round decided it should, and recorded the decision and its reasoning in the serve item. Nothing tests it.

## Why the decision was what it was

Recorded here because an untested contract survives only as long as its rationale is findable. Registration mints regardless of the probe's classification, because refusing would return the user to the prompt with nothing, which is the defect the serve contract exists to fix; because the flaky-mount fix exists to keep a workspace on a flapping mount openable and reporting honestly, so declining to open it inverts that; because `Unavailable` is a sampled, self-clearing overlay, so a refusal keyed to it would make identical commands succeed or fail on probe timing; and because the genuine refusals already exist elsewhere, with a missing window registry declining before the mount and the flock, and a mount failure returning an error before the mint is reached.

## Why it is not already pinned

Because nobody wrote the test, not because the state is out of reach. On Unix it is reachable from a `chan-server` test with no new surface. `WorkspaceHost::probe_mounted_roots` and `WorkspaceHost::workspace_status` are both public, and replacing the root directory under a live tenant (same path, new inode) makes `revalidate_root` fail the identity check, which is the technique `add_answers_a_replaced_root_with_the_row_the_list_reports` already uses in `crates/chan-server/src/routes/library.rs`. Mount the workspace, replace its directory, probe, assert the row reads `unavailable`, then register.

The probe's own transitions are covered too, in `crates/chan-library/src/host.rs`: `probe_reports_a_replaced_root_as_unavailable` and `a_replaced_root_clears_only_when_the_original_directory_returns`, the second of which is the away-and-back case. Windows has no equivalent: it refuses to delete a tree the tenant holds handles inside, and `RootedFs::revalidate`'s non-unix arm has no inode check, so the test is `#[cfg(unix)]` like its precedents.

This section replaces the item's original reasoning, which predates v0.99.0 and held that the state could not be reached without a test-only setter, a feature-gated seam or a probe trait. None of the three has to be chosen.

## Desired contract

The behavior is unchanged: a registration for a mounted but degraded workspace mounts, mints one window, and returns success, and the window and the launcher row are where the degraded state is reported. What this item adds is a test that fails if that changes.

## Boundaries

The discovery handler's tests in `crates/chan-server/src/devserver.rs`. No change to `crates/chan-library/src/host.rs`: the replaced-root technique needs nothing that is not already public there, so this item adds no seam to one subsystem for another subsystem's test.

## Acceptance

1. A test drives a mounted workspace into `Unavailable`, sends a registration for it, and asserts the response is a success carrying a prefix and that exactly one window record was minted.
2. A test asserts the refusals that remain refusals: a missing window registry declines before the mount and before the flock, and a mount failure returns an error with no window minted.
3. No test-only seam is added. If one turns out to be unavoidable, it is confined to a seam named as such where it is defined and unreachable from a release build.
4. The probe's away-and-back transition stays covered; `a_replaced_root_clears_only_when_the_original_directory_returns` already covers it, so this item only has to keep it green.
