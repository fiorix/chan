# A removal forgets its rows before its unregister answers

Status: raised on 2026-10-04 by an independent review of a Services range on the v0.102.0 integration branch, which read that the host's removal forgets a workspace's overlay rows and purges its window records before the registry has answered its unregister; ruled by the lead that day a defect with one defensible fix under the team's rule for a discovery, with its shape chosen among four the builder named, and built on the branch; the owner has not ruled on it and reviews it on the branch and in the lead's rulings.

## Owner ruling

Not yet put to the owner.

## What was seen

`remove_workspace_for_root` in `crates/chan-library/src/host.rs` closed the workspace, took the registry-write permit, forgot the overlay's rows under every spelling of the root (the off row its close had just recorded among them) and purged the workspace's window records, and only then ran the hop that asks the registry to unregister the row. An unregister refused because another process held the writer lock (`WorkspaceLocked`), or because this process still held a handle of the root (`WorkspaceAlreadyOpen`), left a registered workspace whose off row and window records were gone: the next start registered its windows again and the off was lost. A caller that left during the hop was worse: the removal's guard lived in the caller's future and dropped while nothing had been unregistered, and the hop held clones of the registry's state and no host, so a removal the registry then completed purged nothing. The released v0.101.0 and the branch's earlier orders all forgot and purged before the unregister ran.

## Desired contract

A removal changes the overlay and the window records only once its unregister has answered that the row is gone or that no row was there. An unregister refused because another process holds the writer lock or because this process still holds a handle of the root leaves the overlay's rows, the off row its close recorded among them, and the workspace's window records as they were, beside the registration it keeps, and settles its row as before. A removal that completes forgets and purges as before. A caller that leaves at any point, during the hop included, leaves either a registered workspace with a retryable row, its overlay rows and its windows, or a finished removal with its overlay rows forgotten and its windows purged. One removal purges once.

## What to do

Of the four shapes the builder named (the purge on the caller with the records' survival written as a cost; the hop purging the records itself beside the caller's purge, two purges of different reach; the hop reaching the host by a weak handle and purging in one place after the registry's answer; the hop taking the row's writer lock first through a new chan-workspace call), the third: the host keeps a weak handle of itself, the hop's closure clones it, and after the registry has answered that it removed the row or found none, the closure forgets the overlay rows, clears the mount-state rows, upgrades the handle and purges the windows, whoever is still waiting. A host whose handle was never installed (a test host; no production embedder) has no hop purge: there the caller purges after the hop answers, through the same function, and the hop says which of the two ran.

## Boundaries

`crates/chan-library/src/host.rs` (`remove_workspace_for_root`, the hop, the removal guard, the host's own handle) and its tests, and `crates/chan-library/design.md`.

## Acceptance

1. A removal whose unregister is refused, by a foreign writer lock or by a handle this process holds, leaves the overlay's rows and the window records as they were and settles its row as before; pinned red first with an overlay row and a window record under the root.
2. A removal whose caller is dropped while the hop holds its unregister still forgets the rows and purges the windows once the hop has unregistered, and not before; pinned red first with the hop held, ordered by the lock and the probe and by no clock.
3. `crates/chan-library/design.md` says where the purge runs for each way a removal ends, and what a host with no handle leaves.

## What shipped

Built on 2026-10-04 on the v0.102.0 integration branch and not on `main`, in a range the lead accepted on its report, its status files and an independent review of its whole diff, which found nothing above medium and whose one medium was the evidence then owed and since recorded; the reds of its pins at their own assertions at committed shas, sixteen mutations restored by hash, parallel and one-CPU series of two hundred runs per crate with no red, and the gate green at the tip. This record was written that day from those.

The host keeps a weak handle of itself from the moment it is installed, and the hop that unregisters a removal's row clones it. A removal refused before its close changes anything, or at the registry-write permit, forgets and purges nothing. An unregister refused by the registry (`WorkspaceLocked`, `WorkspaceAlreadyOpen`, or any other error of the call) returns at the error, before the closure's forget, its clear and its purge: the overlay keeps its rows, the off the close recorded among them, the window records stay, and the row settles as before. An unregister that answers (the row removed, or none found) forgets the overlay rows, clears the mount-state rows, upgrades the handle and runs the purge on the blocking pool under the closure's registry-write permit, which the closure gives back last, so a removal queued at the permit starts after the purge; the closure answers which of the hop and the caller purged, and the caller purges only when the hop could not. A caller dropped during the hop changes nothing of this. Pinned: both refusals with an overlay row and a window record kept; the held hop with the caller dropped, the records present while the hop is held and gone once it has unregistered; the guards for a host with no handle, a relinked root's records under its stored root, the symlink alias's one overlay row, and one unregister thread per root.

Costs, read in the code: a host whose handle was never installed and whose caller leaves during the hop keeps the workspace's window records after the registry has dropped its row (no production embedder builds such a host); a later removal of that root answers not found and still removes the records stored under the root's key and the path as asked, and a record stored under a stored root that differs from both stays. A refused unregister leaves rows where the released v0.101.0 forgot them, which is the contract.
