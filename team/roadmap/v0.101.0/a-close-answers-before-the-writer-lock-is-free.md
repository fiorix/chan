# A close or a removal beside a call whose caller left answers before the workspace is let go

Status: raised for a decision on 2026-09-28 from the independent review of the caller's root lock (`dev/v0101-team/reviews/review-Services-15.md` in the development tree, the lead's notes, "To raise at the next docs commit, from this review", its first and third sentences), and written in the design document as the code's behaviour (`crates/chan-library/design.md:34`). Read in code at `7957bccef`, where both are pinned; what a user meets afterwards is inferred. One item for two outcomes of one cause, work whose caller left still holding the workspace. Recommendation: a later version.

## What was seen

Work whose caller left can keep the workspace, and with it the writer lock, after its caller's root lock is gone: a revalidation's blocking stat holds a clone of the workspace until it returns (`revalidate_mounted_root`, `crates/chan-library/src/host.rs:1497-1513`), and an abandoned open can hold the writer lock it took (`design.md:32`, `:34`). A close and a removal take no permit and go ahead beside it (`design.md:34`), with two outcomes that say more than holds:

- **A mounted close reports completed while the writer lock is held.** Its teardown waits for the workspace to be let go until a five-second deadline, then returns with a warning that the lock is still held (`wait_for_workspace_release`, `host.rs:4621-4641`; `WORKSPACE_SHUTDOWN_RELEASE_TIMEOUT`, `:49`; `shutdown_with_budget`, `:630-666`), and the close reports completed (`design.md:34`), as `a_mounted_close_finishes_beside_an_abandoned_revalidation` pins (`crates/chan-server/src/devserver.rs:6991`). An on of that root right after meets the workspace this process still holds and, after the release budget, answers that it is still releasing (`host.rs:1389-1405`; `settle_interrupted_mount`, `:4253-4261`), until the stat returns (inferred).
- **A removal fails after it has forgotten the overlay rows and purged the window records.** Beside an abandoned open that owns the writer lock, the removal's unregister fails with `WorkspaceAlreadyOpen` after the overlay's forget and the window purge have run (`remove_workspace_for_root`, `host.rs:3385-3440`; `design.md:34`), as `a_removal_answers_while_an_abandoned_open_owns_the_writer_lock` pins (`host.rs:6473`); the launcher's delete and the devserver's forget answer it with HTTP 500 (`crates/chan-server/src/routes/library.rs:1997`; `devserver.rs:2968`). The purge reaps the windows' terminal sessions and session blobs (`discard_workspace_windows`, `host.rs:2930-2939`; `reap_discarded_window_state`, `:2941-2951`), and the workspace stays registered with a row that says to retry (`design.md:42`). The order is the design's on purpose: a removal its caller abandons ends registered with a row to retry, or finished, and a retry repeats the forget and the purge harmlessly (`design.md:42`).

## Desired contract

A close or a removal beside work whose caller left says what holds: a close whose workspace is still held reports that it is still releasing, not that it completed, and a removal that cannot unregister answers a refusal a client can act on, in words that say the workspace is still releasing.

## What to do

A later version, by the recommendation. As suggestions: a close whose release check runs out reports the workspace as still releasing; a removal asks whether a live owner holds the writer lock before its forget and its purge, and refuses with a sentence and a status that is not a server error. The second weighs the design's rule on an abandoned removal's two states (`design.md:42`).

## Boundaries

`crates/chan-library/src/host.rs` (the close's teardown answer and `remove_workspace_for_root`), the launcher's delete and the devserver's forget where they map the answer, and `crates/chan-library/design.md`, with their tests.

## Acceptance

1. A mounted close beside an abandoned revalidation, whose writer lock is still held at its deadline, answers what holds, pinned.
2. A removal beside an abandoned owner of the writer lock answers a refusal that says so, and what it has forgotten by then is what the design says, pinned.
