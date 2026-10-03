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
