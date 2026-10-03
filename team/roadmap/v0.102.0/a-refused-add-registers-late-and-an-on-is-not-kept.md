# An add refused at the bound can register later, and a launcher's on alone is restored off

Status: raised for a decision on 2026-09-30 and held under v0.102.0, since the owner closed v0.101.0's intake on 2026-09-29. These are two costs that the items of their landings write and that no item held: the first in [an-open-with-no-bound-holds-a-hung-roots-lock](../done/an-open-with-no-bound-holds-a-hung-roots-lock.md), the second in [a-relinked-root-window-nests-outside-its-row](../done/a-relinked-root-window-nests-outside-its-row.md). On 2026-09-29 the owner confirmed both as written costs, with the rulings of the lead's that they follow from: the question put was whether to accept them as written costs or to have rows raised, and the answer accepted was to confirm them with their cost. The round's records still list them among the findings that no row holds (`dev/v0101-team/machine-move/lead38-host-review-ruled-2026-09-29.md` in the development tree, section 8, "Item text"; `dev/v0101-team/machine-move/lead38-recon-1-prior-host-questions.md`, C38), so this row is raised to hold them, and what is left to decide is whether either is ever built. Both were read, and neither was run. Ruled on 2026-10-03: see Owner ruling.

## Owner ruling

On 2026-10-03 the owner ruled, as the lead recommended: both stay written costs and neither is built; the row closes with no build.

## What was seen

Each as the item that writes it has it, with that item's lines.

- **An add refused at the sixty-second bound can still register its workspace once the root answers.** The launcher's add registers the root on the blocking pool, and the bound drops the add's wait for that registration and not the task, which writes the registry row when the root answers; so a row can appear later with nothing mounted, since the add's own overlay write never ran (`crates/chan-server/src/routes/library.rs:1903-1907`, `:1919`; `register_workspace_with_name`, `crates/chan-workspace/src/library.rs:235-254`; lines at `fe2708e45`). Read by the lead at the lane's tip and again at the landing.
- **A workspace added or turned on from the launcher alone is restored off after a restart.** An add or a launcher's on leaves no devserver record: it writes its overlay row under the runtime's root, and the next devserver save of any workspace writes the rows of its own records alone and makes them the whole overlay, so a restart after that save restores the workspace off (`set_overlay`, `crates/chan-server/src/routes/library.rs:1802-1806`, called at `:1915` and `:1975`; `crates/chan-server/src/devserver.rs:1659-1664`; `crates/chan-library/src/workspace_persist.rs:157`; lines at `ada0ecc4c`). That item says that it is older than its landing, from the fix round's report of what was left as ruled.

Not established: either of them in a run; how often a user meets the first, which needs a root that does not answer for sixty seconds and answers afterwards; and whether the second shows on the desktop's embedded host as it does on a devserver.

## Desired contract

Not written yet: both are costs that the owner confirmed as written, and no record says what should hold in their place.

## What to do

Decide whether either is built, and in which version, or whether both stay written costs and this row closes with no build.

## Boundaries

By the two items' citations: the launcher's add and on in `crates/chan-server/src/routes/library.rs`, the devserver's save in `crates/chan-server/src/devserver.rs`, `crates/chan-library/src/workspace_persist.rs`, and `register_workspace_with_name` in `crates/chan-workspace/src/library.rs`. A registration that takes a thread for each caller that gives up is [a-hung-root-takes-a-thread-per-expired-caller](a-hung-root-takes-a-thread-per-expired-caller.md)'s.

## Acceptance

1. The owner's decision is recorded for each of the two.
2. If the first is built: an add refused at the bound leaves no registry row that appears afterwards; pinned.
3. If the second is built: a workspace turned on from the launcher alone is on after a devserver's save and a restart; pinned.
