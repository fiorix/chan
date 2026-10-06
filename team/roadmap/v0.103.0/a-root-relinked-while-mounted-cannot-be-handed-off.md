# A root relinked while it is mounted cannot be handed off when no devserver record of it reads mounted

Status: reproduced in two controlled tests; the repair is undergoing component validation and is not yet integrated.

## Owner decision, 2026-10-06

First settle registry and runtime identity under the row claim, then reproduce the relinked mounted-root handoff with a controlled test. If confirmed, resolve the handoff to the correct mounted runtime. Do not weaken the writer lock to suppress the error. No reproduction or repair is established by this decision.

## Controlled reproduction, 2026-10-06

After the row-claim changes, tests-only commit `e022ccdffce607335731c0e3b2f2bd6df1b75b6f` reproduced the two requests at a clean source snapshot. The fixture mounts the workspace through the host without a mounted devserver record, moves its parent directory and replaces that parent with a symlink. A handoff through the new path then fails with the other-process lock message; turning the workspace on through its registry row fails with `WorkspaceLocked`. Each exact test compiled, ran and reached its intended assertion with exit101. Neither failure was a fixture wait or timeout. Independent review accepted both reproduction results.

This establishes the lock symptom under the controlled relink, not its frequency in use or the desktop path. The tests live on the author's branch and have not yet been integrated into this candidate. The source diagnosis and proposed repair are being validated separately; the writer lock remains part of the required contract. The retained commands, full output and source identities are recorded in `dev/v0103-team/reports/handback-Runtime103-I2-reproduction.md` and `dev/v0103-team/reviews/review-Review103-Runtime103-I2-focused-red-1.md` in the development tree.

## Record before this decision

Every section below records the state before the dated decision above and is preserved as history. The dated decision governs the current scope.

Previous status: moved to v0.103.0 on 2026-10-05, before the v0.102.0 GA, by the owner's ruling of 2026-10-03 that it is not built in v0.102.0 and carries to a later version; still raised for a decision.

Record before the move: raised for a decision on 2026-09-30 and held under v0.102.0, since the owner closed v0.101.0's intake on 2026-09-29; the owner had not ruled on this item then. It is the one residual of [a-relinked-root-window-nests-outside-its-row](../done/a-relinked-root-window-nests-outside-its-row.md) that had no item, written in that item's lists of what is left on 2026-09-28 from the readings the lead listed for its landings, and found without a row by a reading of the ledger on 2026-09-29 (`dev/v0101-team/machine-move/lead38-recon-5-runtime-launcher-drawing.md` in the development tree, T5, part b). Read in code and not run; no pin relinks a root while it is mounted. Ruled on 2026-10-03: see Owner ruling.

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

By that item's citations: the runtime's keys and the open in `crates/chan-library/src/host.rs`, `Library::open_workspace` in `crates/chan-workspace/src/library.rs`, and the writer lock's comparison in `crates/chan-workspace/src/lock.rs`. A launcher's add or on that leaves no devserver record is a cost held by [a-refused-add-registers-late-and-an-on-is-not-kept](../done/a-refused-add-registers-late-and-an-on-is-not-kept.md).

## Acceptance

1. The owner's decision is recorded.
2. If it is built: a handoff of a root that was relinked while it is mounted, with no devserver record of it reading mounted, opens its window and does not answer that the workspace is locked by another process; pinned red first by a test that relinks a mounted root.
