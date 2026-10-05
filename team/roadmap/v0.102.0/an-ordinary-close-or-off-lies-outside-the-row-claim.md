# An ordinary close or off lies outside what a removal's row claim guarantees

Status: raised on 2026-10-04 from the reading of the gaps of [four-gaps-lie-outside-a-removals-row-claim](four-gaps-lie-outside-a-removals-row-claim.md), which found a fifth that the design record of [a-removal-does-not-hold-the-row-it-selected](../v0.103.0/a-removal-does-not-hold-the-row-it-selected.md) names beside those four and that no item holds; read from source at `e8a47bda1`, with `crates/chan-library/src/host.rs` and `crates/chan-server/src/devserver.rs` read also at `f66a27602`, a range built on it and not yet landed. Not seen on a display and not run. Ruled by the owner on 2026-10-04: closed as a written cost, its same-generation tie a cost of the snapshot gap.

## Owner ruling

On 2026-10-04 the owner closed the row as a written cost, as the lead recommended (the tenth decision file, S5, option c): an ordinary close or off lies outside a removal's row claim, and its same-generation tie is a cost of the snapshot gap, ruled under S2 of the same file.

## What was seen

The design record names it three times and gives it no lines: "independent ordinary close/off behavior", "ordinary Off outside the stated Starting gap", and "ordinary Off" among what "remain open". Its row claim orders a removal against a registration, an open and a publication of the same row; a close or an off that is not a removal holds no claim. The off of a workspace still starting is the first gap of [four-gaps-lie-outside-a-removals-row-claim](four-gaps-lie-outside-a-removals-row-claim.md) and is not repeated here.

Three kinds of ordinary close reach a workspace that a removal may hold:

- **The devserver's off** (`DevserverState::set_workspace_on` in `crates/chan-server/src/devserver.rs`, lines 1466-1539 at `e8a47bda1`, 1483-1575 at `f66a27602`), from the desktop's view of the devserver or the devserver's management route. It closes by prefix (`WorkspaceHost::close_workspace`, `crates/chan-library/src/host.rs` line 4107 at `e8a47bda1`, 4293 at `f66a27602`), which finds the runtime by prefix and takes no root lock (`close_workspace_impl`, lines 4115-4183 at `e8a47bda1`, the lookup at 4129-4131; 4301-4394 at `f66a27602`). A removal holds the root's lock from its close through its unregister (`remove_workspace_for_root`, lines 3943-4092 at `e8a47bda1`, the lock at 3949; 4117-4269 at `f66a27602`, the lock at 4126), so the two are not ordered.
- **The host's close by root**: the launcher's off (`handle_workspace_off`, `crates/chan-server/src/routes/library.rs` lines 2088-2112 at `e8a47bda1`, 2100-2124 at `f66a27602`), `chan close` through the control socket (`handle_unserve`, `crates/chan-server/src/control_socket.rs`, the close at line 1948) and the desktop's handoff close (`close_workspace_from_handoff`, `desktop/src-tauri/src/main.rs` lines 3052-3115 at `e8a47bda1`). It takes the root's lock under the key it resolves (`close_workspace_for_root_impl`, host.rs lines 3625-3636 at `e8a47bda1`, the lock at 3632; 3759-3773 at `f66a27602`), so it is ordered against a removal of the same key; a stored root that now resolves elsewhere takes another key, as the method's own description says (lines 3643-3653 at `e8a47bda1`).
- **The launcher's off on a devserver** touches no devserver record, as the What shipped of [a-launcher-delete-leaves-a-devserver-record-on](a-launcher-delete-leaves-a-devserver-record-on.md) records; the devserver's next save folds its off row in by generation (`WorkspaceRecord::reconcile_persisted`, devserver.rs lines 566-586, the same at both shas).

What one of them does beside a removal, read at both shas:

- **A devserver off beside a forget.** (1) A forget of a workspace (the launcher's delete, which on a devserver is the devserver's forget, or `chan workspace forget`) takes the root's lock, closes the runtime and marks the row removing (`mark_mount_removing_by_key`, host.rs line 3975 at `e8a47bda1`, 4152 at `f66a27602`), then waits for its registry permit and wipes. (2) A devserver off of the same workspace reads its record still mounted, closes by prefix and finds nothing, turns the record off, clears the root's lifecycle row (devserver.rs line 1531 at `e8a47bda1`; lines 1561-1564 at `f66a27602`, which skip the clear while a close's teardown still runs) and answers 200 with the workspace off. (3) The removal finishes and the workspace goes. Seen: an off answered as done for a workspace a removal is taking away, and the launcher's row reading stopped, not removing, while the removal still wipes. The off's save writes an off row while the row is still registered, and the removal's last forget, after its unregister (host.rs lines 4051-4053 at `e8a47bda1`), drops it.
- **The reverse order.** A devserver off that takes the runtime first leaves the removal's close nothing to close; today the removal goes on and unregisters. Under the row claim's design, a removal whose selected runtime has gone answers that the workspace is still releasing, with nothing changed: the design's own declared cost that a forget answers retry earlier and more often.
- **A close beside a removal of a relinked root,** under another key: its off write is forgotten again when the registry no longer holds the row (`record_off_while_registered`, host.rs lines 3747-3761 at `e8a47bda1`), the fix of [a-late-off-row-outlives-a-removal](a-late-off-row-outlives-a-removal.md); one of its two arms has no pin of its own, as that item records.
- **A host off against a devserver on at one generation.** The devserver's record and the overlay row count generations apart, so a devserver on and a host off of a workspace still starting can meet at one value, and the devserver's save keeps its on over the off that `chan close` reported as done (`reconcile_persisted` ignores an equal row, devserver.rs line 567; `WorkspaceOverlay::replace`, `crates/chan-library/src/workspace_persist.rs` lines 137-160, keeps the snapshot's row at a tie, line 154). This one loses a user's off; it is read with the overlay gap of [four-gaps-lie-outside-a-removals-row-claim](four-gaps-lie-outside-a-removals-row-claim.md).

What narrows it at `f66a27602`: a close whose teardown passes its bound answers that the workspace is still releasing, and a close or removal by root that finds no runtime while that teardown runs answers the same before it changes anything (`close_workspace_for_root_locked`, host.rs lines 3852-3880 at `f66a27602`), so a removal that follows an ordinary close's held teardown is ordered by the teardown's permit.

Who reaches it: one user acting twice on one workspace, turning it off from the desktop's view of the devserver and deleting it from the launcher, or the reverse; or two clients acting on one workspace at once. The tie needs a devserver on and a host off within one save's span. Not established: what the stop's sweeps (`shutdown_mounted`, `shutdown_all` in host.rs) do beside a removal in flight. By this reading nothing here loses state chan keeps for a workspace except the tie's off.

## Desired contract

Not written yet. The reading proposes: an off or a close and a removal of the same workspace are ordered, each acting on what the other left or answering retry, and each answer is true when it is given: an off answered as done leaves the workspace unmounted and off, and a removal's row reads as the removal left it until it ends.

## What to do

Decide, as the options below put it, whether this is an item of its own, a part of the build of the row claim, or a written cost.

- (a) An item of its own, built after the row claim: every close and off takes the row's claim as a holder that removes nothing, or the root's lock under the key the removal takes, so an off and a removal of one row are ordered; and the devserver's off writes its record's intent through one generation order shared with the host's writes. Cost: `crates/chan-library/src/host.rs`, `crates/chan-server/src/devserver.rs` and `crates/chan-server/src/routes/library.rs`; more answers of retry; an off of a root that has stopped answering must still settle from the keys it stores, which is pinned today.
- (b) A part of the row claim's build: only the devserver's off is made to answer retry beside a removal of the same row while the claim is held, through the claim that build adds, with a test that a seam orders; the tie stays with the overlay gap. Cost: a few commits in `crates/chan-server/src/devserver.rs` inside that build, which the owner approved without it.
- (c) A written cost: a removal's progress row can be cleared by a concurrent off, a removal beside an off answers retry (the design's declared cost), and the tie is ruled with the overlay gap.
- **Recommended: (c),** with the tie decided under the overlay gap of [four-gaps-lie-outside-a-removals-row-claim](four-gaps-lie-outside-a-removals-row-claim.md). What is left here is a row's words and a retry, with no state lost, and ordering every close against the claim widens an approved design.

## Boundaries

`crates/chan-server/src/devserver.rs` (`set_workspace_on` and its settlement on a dropped request), `crates/chan-library/src/host.rs` (`close_workspace`, `close_workspace_for_root`, `remove_workspace_for_root`), `crates/chan-server/src/routes/library.rs` (`handle_workspace_off`) and `crates/chan-server/src/control_socket.rs` (`handle_unserve`), with their tests and design documents. The generation tie's fix belongs with the overlay gap, and the off of a workspace still starting with the first gap, of [four-gaps-lie-outside-a-removals-row-claim](four-gaps-lie-outside-a-removals-row-claim.md); the claim itself is [a-removal-does-not-hold-the-row-it-selected](../v0.103.0/a-removal-does-not-hold-the-row-it-selected.md)'s.

## Acceptance

1. The owner's decision is recorded: an item of its own, a part of the row claim's build, or a written cost.
2. If built: a devserver off and a forget of one workspace, ordered by a seam in each order, answer truly and leave the removal's row reading as the removal left it; pinned red first.
3. If written as a cost: the design documents say what an off or a close guarantees beside a removal, and what it does not.
