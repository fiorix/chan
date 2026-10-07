# A root relinked while it is mounted cannot be handed off when no devserver record of it reads mounted

Status: shipped in [v0.103.0](../../release/release-v0.103.0.md).

Record before the release: implemented and independently accepted as a component; the combined gate passed at the candidate `7fa1676c3` (whole `make ci-linux`, including the four-suite symlinked-temp arm and the Windows GNU target lint). Three of its relink tests were repaired test-only during the gate for asking the registered open by a temp-path alias where the registry stores the resolved root; a recorded limit stands below.

## Owner decision, 2026-10-06

First settle registry and runtime identity under the row claim, then reproduce the relinked mounted-root handoff with a controlled test. If confirmed, resolve the handoff to the correct mounted runtime. Do not weaken the writer lock to suppress the error. No reproduction or repair is established by this decision.

## Controlled reproduction, 2026-10-06

After the row-claim changes, tests-only commit `e022ccdffce607335731c0e3b2f2bd6df1b75b6f` reproduced the two requests at a clean source snapshot. The fixture mounts the workspace through the host without a mounted devserver record, moves its parent directory and replaces that parent with a symlink. A handoff through the new path then fails with the other-process lock message; turning the workspace on through its registry row fails with `WorkspaceLocked`. Each exact test compiled, ran and reached its intended assertion with exit101. Neither failure was a fixture wait or timeout. Independent review accepted both reproduction results.

This establishes the lock symptom under the controlled relink, not its frequency in use or the desktop path. At that reproduction checkpoint the tests were on the author's branch and the repair was not yet validated or integrated. The writer lock remains part of the required contract. The retained commands, full output and source identities are recorded in `dev/v0103-team/reports/handback-Runtime103-I2-reproduction.md` and `dev/v0103-team/reviews/review-Review103-Runtime103-I2-focused-red-1.md` in the development tree.

## Implemented repair and component evidence, 2026-10-06

The candidate integrates the source from the three author commits `e022ccdffce607335731c0e3b2f2bd6df1b75b6f`, `c25820360259cc02551e646918c5e11e92c2d47a` and `b07a42e6a8bf9c9b5371779a5974726f1548eeb4` after the accepted row-claim work. These are the author revisions under review and test, not claims about the candidate's commit ancestry. The three integrated Rust files match the final author blobs.

An idempotent open selects the stored registry row and captures a matching mounted runtime's original canonical lock key and private mount identity. Under that lock it rechecks the row and the exact runtime. A close or replacement while it waits produces the existing retry refusal rather than reopening under an obsolete key or returning a replacement with the same prefix and key. With no captured runtime, the selected row and the path's ownership are checked before handoff or opening, and the opened workspace's metadata key is checked before publication. An unmounted A whose path redirects to registered B therefore cannot borrow B through a direct A open. A devserver handoff first registers its spelling and may correctly select B for that request. An arbitrary new-spelling host call without registration remains outside the repair; the writer lock and publication use are preserved.

The two original assertion reds are followed by seven focused passes. The clean `c2582036` library gate passed fmt, all-target clippy, 605 tests with zero failures and one ignored, and rustdoc. Its first server gate remained red at an existing fixture entrance wait after 2,110 passes, one failure and two ignored; that run did not reach the fixture's later behavior assertion. The route-only `b07a42e6` correction selects the named workspace-open and root-revalidation steps without changing the behavior assertion. Its clean server gate passed fmt, all-target clippy, 2,111 tests with zero failures and two ignored, and rustdoc. The later route-only commit leaves the gated library bytes unchanged; the library gate is attributed to its actual `c2582036` invocation.

Four targeted mutations each compiled, failed its intended behavior assertion and restored clean source: losing the captured key, reopening after capture loss, using another row in the no-capture path, and accepting a replacement mount with the same prefix and key. A source-matched native desktop API compile passed using retained bundles; it proves neither packaging nor the desktop handoff in use. Independent review accepted the committed repair and these component results. Full commands, statuses, superseded failures and source identities are in `dev/v0103-team/reports/handback-Runtime103-I2-final.md`, `dev/v0103-team/reports/intake-Lead103-runtime-I2.md` and `dev/v0103-team/reviews/review-Review103-Runtime103-I2-final-range-1.md`. The frozen combined gate remains owed.

## Recorded limit, 2026-10-06

An open by an alias spelling of a root that was relinked since it was mounted is answered that the workspace is locked, for a workspace this process holds: the registered open finds a mounted row only by the root the registry stores, which is the resolved path, and the launcher's add route registers first and then passes the request's own spelling, not its row's root, to the open (`crates/chan-server/src/routes/library.rs`, the register and open calls). It is a refusal with a misleading reason, reached only by a relink under a mounted workspace plus an open by another spelling; it is outside the accepted contract of this item, which names a direct host call by an arbitrary new spelling as outside scope, and nothing was changed for it in this round. Whether passing the row's root would serve the case, and what spelling the desktop's own call passes, were not traced. The three tests that failed the gate's symlinked-temp arm asked the open by exactly such an alias and were repaired to ask by the stored root; the gate at the candidate is green in both arms.

## Record before this decision

Every section below records the state before the dated decision above and is preserved as history. The dated decision governs the current scope.

Previous status: moved to v0.103.0 on 2026-10-05, before the v0.102.0 GA, by the owner's ruling of 2026-10-03 that it is not built in v0.102.0 and carries to a later version; still raised for a decision.

Record before the move: raised for a decision on 2026-09-30 and held under v0.102.0, since the owner closed v0.101.0's intake on 2026-09-29; the owner had not ruled on this item then. It is the one residual of [a-relinked-root-window-nests-outside-its-row](a-relinked-root-window-nests-outside-its-row.md) that had no item, written in that item's lists of what is left on 2026-09-28 from the readings the lead listed for its landings, and found without a row by a reading of the ledger on 2026-09-29 (`dev/v0101-team/machine-move/lead38-recon-5-runtime-launcher-drawing.md` in the development tree, T5, part b). Read in code and not run; no pin relinks a root while it is mounted. Ruled on 2026-10-03: see Owner ruling.

## Owner ruling

On 2026-10-03 the owner ruled, as the lead recommended: it is not built in v0.102.0 and carries to a later version.

## What was seen

As that item has it, with its lines.

A mounted runtime keeps the two keys it had at its mount, the stored root and the canonical path that root resolved to then (`crates/chan-library/src/host.rs:1645-1679`; lines at `b39274a1a` in this paragraph). When the root is relinked while it is mounted, a handoff of the new canonical path finds no runtime by it (`found_by`, `:617-619`; `open_or_get_registered_workspace`, `:1452-1466`) and opens the workspace again. The library's own check for a handle it still holds keys by the canonical path as it resolves now and misses the handle it keeps under the old one (`Library::open_workspace`, `crates/chan-workspace/src/library.rs:303-329`); the writer lock, which this process holds under the same metadata key, compares the holder's record, which names the old path, with the new one and reads the holder as another process (`WorkspaceLock::acquire` and `try_steal`, `crates/chan-workspace/src/lock.rs:217-227`, `:236-271`; the record's path, `:510-513`, `:538-544`). The open then answers `workspace is locked by another process` at once, and the handoff answers with that error.

One devserver record per workspace narrowed it on 2026-09-28 (lines at `ada0ecc4c`): where the devserver's own record reads mounted, a handoff of the new path, or an on from the row, is answered by its registration with the row that stores the root and finds that record still mounted, so no attempt runs and the prefix is answered (`begin_registered_mount`, `crates/chan-server/src/devserver.rs:1144-1158`, `:1161-1163`; `touch_matched`, `crates/chan-workspace/src/registry.rs:384-391`). Where no devserver record of the workspace reads mounted, as after the launcher's add or on alone, the attempt opens the stored root, which resolves to the new path, finds no runtime by it and opens the workspace again, and the paragraph above holds.

Through the desktop, by the plan's inference, which no pin runs: a handoff of such a root's new path finds no runtime by it, and the registration answers the row's stored root, by which `serve::start` finds the runtime and mints its window (`desktop/src-tauri/src/main.rs:2978`, `:2986-3013`; `desktop/src-tauri/src/serve.rs:81-88`; lines at `d440ab656`; `dev/v0101-team/followups/followup-Services-Lead-21.md`, amendment 2a; `dev/v0101-team/reviews/review-Services-17.md`, F1).

Not established: the refusal in a run; how a user comes to relink a mounted root and hand it off; and whether the desktop's path is whole, since it is inferred.

## Desired contract

A handoff of a mounted workspace's folder by the path it resolves to now reaches the runtime that serves it and opens its window, as a handoff by the path it was mounted at does.

## What to do

Decide. The records name no shape for it. A test that relinks a root while it is mounted comes first, since none exists and the reading is pinned by nothing.

## Boundaries

By that item's citations: the runtime's keys and the open in `crates/chan-library/src/host.rs`, `Library::open_workspace` in `crates/chan-workspace/src/library.rs`, and the writer lock's comparison in `crates/chan-workspace/src/lock.rs`. A launcher's add or on that leaves no devserver record is a cost held by [a-refused-add-registers-late-and-an-on-is-not-kept](a-refused-add-registers-late-and-an-on-is-not-kept.md).

## Acceptance

1. The owner's decision is recorded.
2. If it is built: a handoff of a root that was relinked while it is mounted, with no devserver record of it reading mounted, opens its window and does not answer that the workspace is locked by another process; pinned red first by a test that relinks a mounted root.
