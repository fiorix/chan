# Four gaps lie outside what the design of a removal's row claim guarantees

Status: raised for a decision on 2026-09-30 and held under v0.102.0, since the owner closed v0.101.0's intake on 2026-09-29; the owner had not ruled on this item then. The four are named as open by the design record of [a-removal-does-not-hold-the-row-it-selected](../v0.103.0/a-removal-does-not-hold-the-row-it-selected.md): its reviews and the lead's dispositions on them call each "separate acceptance work" (`dev/v0101-team/reviews/review-Runtime-24.md` and `review-Runtime-25.md` in the development tree, with `dev/v0101-team/followups/followup-Runtime-Lead-33.md`), and a reading of the ledger on 2026-09-29 found no item for any of them (`dev/v0101-team/machine-move/lead38-recon-6-runtime-hold.md`, section 2a and "Ledger corrections", which says that its search was not exhaustive). Read from source by the design's builder and its reviewers; nothing was run, and no test holds any of the four. Ruled on 2026-10-03: see Owner ruling.

## Owner ruling

On 2026-10-03 the owner ruled, as the lead recommended: accepted as a reading. Each of the four gaps is read against the current code, with lines, and ruled after that reading.

## What was seen

The design of the row claim is a source contract of which no line is written: a private claim, held in memory, that reserves the registry row a removal selected from its selection to the end of its unregister. Its reviews say what that claim does not settle. The lines below are the reviews', at the base the design was read against, and were not read again for this item.

- **An off of a workspace that is still starting can be acknowledged, and the old attempt can publish a runtime afterwards.** The design keeps it "as an explicit separate failing acceptance expectation" (`followup-Runtime-Lead-33.md`, its additional proposed pins), and the last review names it "Off-of-Starting acknowledgement" among the work that stays separate (`review-Runtime-25.md`, its last paragraph). No lines are given for it.
- **The overlay's snapshots are written as whole vectors,** which can bring back a row that a removal took out or drop one that a registration added. The devserver's save replaces the overlay (`crates/chan-server/src/devserver.rs:1690-1736`; `crates/chan-library/src/workspace_persist.rs:133-160`, as `review-Runtime-24.md` cites them), and a restore's settlement on success, on failure and on a drop calls that save (`devserver.rs:1182-1242`, `:1317-1334`, `:954-963`, as `review-Runtime-25.md`, finding 4, cites them). The design promises only that its own restore path does not overwrite or erase a row it skipped, "not global preservation against those other writers" (`followup-Runtime-Lead-33.md`).
- **An idle devserver record can be taken for a new row at the same path,** once the row it was made for has been replaced. The reviews name it "idle `WorkspaceRecord` attribution after same-path replacement" and give it no lines.
- **The native desktop's snapshot writer** publishes outside the claim. The reviews name it "native desktop snapshot publication" and give it no lines.

Not established: what a user sees in each case, beyond the clauses above; whether any of the four can be reached without the concurrency that the removal race needs; how often; and whether any of them loses state that chan keeps for a workspace. None was reproduced, and executable work on the removal race is stopped by the owner's ruling of 2026-09-29.

## Desired contract

Not written yet. The records say what the row claim does not guarantee, and say of none of the four what should hold in its place.

## What to do

Decide, for each of the four, whether it is an item of its own, a part of the build of the row claim, or a cost to write down. The What to do of [a-removal-does-not-hold-the-row-it-selected](../v0.103.0/a-removal-does-not-hold-the-row-it-selected.md) asks that the four be raised before or with that build; this item raises them as one row, to be split if they are decided apart. A reading of each against the code then in hand comes first, since the lines above are the reviews' at an older base and two of the four have none.

## Boundaries

By the reviews' citations, `crates/chan-server/src/devserver.rs` and `crates/chan-library/src/workspace_persist.rs`; the desktop's snapshot writer, which the records do not locate. The row claim itself is [a-removal-does-not-hold-the-row-it-selected](../v0.103.0/a-removal-does-not-hold-the-row-it-selected.md)'s.

## Acceptance

1. Each of the four has a recorded decision: an item of its own, a part of the row claim's build, or a written cost.
2. Each that becomes work is read against the code at that time, with its lines, before an order is cut.

## Reading of 2026-10-04

Read on 2026-10-04 against the v0.102.0 integration branch, at `e8a47bda1`, with the host's close and teardown, a removal's permit and the devserver's off read also at `f66a27602`, a range built on it and not yet landed; read from source, nothing run, and this record was written that day from that reading. The first gap, an off of a workspace still starting, is recommended as a part of the build of the row claim, since that build's conservative result for a stale completion closes nothing and would keep a runtime published behind an off already answered as done; beside it the reading found a same-generation tie, in which a host's off of a workspace still starting and the devserver's on meet at one generation and the devserver's save keeps the on, which is ruled with the second gap. The second, the overlay's whole-vector snapshots, is recommended as a written cost, with the build's own split of the restore's saves kept as designed and the tie left to be ordered on its own if the owner wants it closed. The third, an idle devserver record taken by a workspace added again at the same path, is recommended as an item of its own, [an-idle-devserver-record-is-taken-by-a-re-added-path](an-idle-devserver-record-is-taken-by-a-re-added-path.md). The fourth, the desktop's snapshot writer, found in `desktop/src-tauri/src/main.rs` (`snapshot_workspaces`), is recommended as a written cost. The reading also found a fifth gap that the design record names beside these four, raised as [an-ordinary-close-or-off-lies-outside-the-row-claim](an-ordinary-close-or-off-lies-outside-the-row-claim.md). The owner's ruling on each is pending. On 2026-10-04 the owner ruled each as recommended: the first gap is built inside the removal's own build with a seam-ordered pin; the second and the fourth are written costs, the second's same-generation tie not closed on its own; the third is an item of its own, accepted for a build; the fifth closes as a written cost. This row is complete. The reading also found this item's Boundaries short of four files its gaps reach (`desktop/src-tauri/src/main.rs`, `crates/chan-library/src/host.rs`, `crates/chan-server/src/routes/library.rs`, `crates/chan-server/src/control_socket.rs`), its cited lines older than the branch, and a neighbouring item closing a save-during-a-stop finding that its own acceptance still asks to trace.
