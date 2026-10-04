# A forget finds its host by the lock record alone

Status: raised for a decision on 2026-10-03 by the builder of [chan-workspace-forget-ignores-the-hosts-answer](chan-workspace-forget-ignores-the-hosts-answer.md), as a finding beside that build; the owner had not ruled on it then. Read in the code on the v0.102.0 integration branch; not run. Ruled on 2026-10-03: see Owner ruling.

## Owner ruling

On 2026-10-03 the owner ruled, as the lead recommended: accepted for a build, with a code map first. The command reaches a running devserver through its discovery and asks it, since one devserver owns its library's writes.

## What was seen

`chan workspace forget` finds the process that holds a workspace only through the workspace's lock record (`unserve_running`, `crates/chan/src/close.rs`). A workspace that is registered on a devserver and not mounted has no record, so the command prints that nothing serves it and unregisters it on disk, and the devserver's library in memory keeps the row. That was so before v0.102.0 for any unmounted workspace. Since the forget's exit 75 it is also where the command's own second run leads: a host answers still releasing after its close has released the lock, so the second run finds no record, forgets the workspace on disk and exits 0, and the host is not asked.

## Desired contract

Not written yet. The choice is how a forget reaches the host of a registered workspace that nothing has mounted: through the devserver's own discovery, through a flag that names the host, or not at all, with the registry on disk as the one truth for an unmounted workspace and the devserver reading it again.

## What to do

Rule which. Then build it red first: a forget of a workspace registered on a running devserver and not mounted.

## Boundaries

`crates/chan/src/close.rs` and its tests, and what the ruling adds on the host's side.

## Acceptance

1. The ruling is recorded.
2. If it changes the command: after a forget of a workspace registered on a running devserver and not mounted, the devserver's library and the registry on disk agree; pinned red first.

## What shipped

Built on 2026-10-04 on the v0.102.0 integration branch and not on `main`, in a range the lead accepted on its report, its status files and two independent reviews of its diff, the second of a repair the first asked for, and the contract is met. This record was written that day from those.

Where the lock record names no holder, or a holder whose pid has no reachable control socket, `chan workspace forget` asks the one discovered devserver whose library root is the CLI's over a control socket of its pid, with the existing close request that removes (`forget_on_library_devserver`, `matching_devserver`, `crates/chan/src/close.rs`): no new wire. It asks only while the workspace's writer lock is free: a holder that bound no control socket keeps its workspace, its overlay row and its window records, and the command exits 1 as before. More than one matching devserver, or a matching one whose control socket cannot be reached, refuses and unregisters nothing, naming the devserver; any other error answer refuses the same way, and a live-terminals count or a still-releasing answer read as on the other routes. With no matching devserver the command does what it did. `CHAN_NO_DEVSERVER_HANDOFF` does not skip the ask. Pinned against real devservers: the overlay's off row gone and the workspace absent after a restart, two libraries in one runtime directory, more than one matching instance, unreachable sockets, an error answer, the held lock.

What the record of this item got wrong, read in the code: the devserver does not keep the row in memory after a forget on disk, since its registry reload watcher drops it; what stayed was the overlay's off row and the window records, which the next start registered again. Costs, accepted: a forget right after an add, beside a devserver whose reload has not run, is answered not found and exits 1 unregistering nothing, where it exited 0; the reply's wait is unbounded, as the lock-record route's is; a standalone holder beside a separate devserver's off row is outside this route.
