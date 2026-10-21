# A queued upload whose client gave up holds its waiting slot until a worker reaches it

Status: carried into v0.109.0 at the v0.108.0 GA on 2026-10-21, still raised for a decision.

Record before the release: carried into v0.108.0 at the v0.107.0 GA on 2026-10-17, still raised for a decision.

Record before the release: raised on 2026-10-16 by the lead from the runtime seat's design of the check 62 item, read at source by that seat and reproduced in its guest; written down with the repair's shape; built by the runtime seat after its lane's items; owner the runtime seat.

## What was seen

Read at source at `a54966060` and reproduced (`dev/v0107-team/evidence/Runtime107/c62err/`). An upload (`POST /api/fs/upload` through `stream_upload_tracked`, `routes/files.rs`) that arrives while the transfer lane's two active slots are held (`bulk_transfer.rs` `ACTIVE_CAPACITY`) waits in the lane's queue with its request open. When its client closes the connection, the feed sees the body fail at once, but the handler waits for the job's outcome, and the job reports only when a worker reaches it, that is when an active slot frees. In check 62's queue legs that is about 70 s under the throttle: the queued, cancelled upload's answer and its log line arrive beside the first held upload's completion. Meanwhile the abandoned request holds its place in the queue: every upload behind it is announced one place further back, it counts toward `WAITING_CAPACITY`, and its own answer comes late. One boundary of the reading: the feed sends the body through an eight-message channel, so a queued upload whose body fills that channel stops reading and does not see its client's close until a worker drains it; the item covers the queued upload whose feed is still reading when the client closes.

Not established: a reading in a served instance under real traffic; the queue depth at which a user notices.

## Desired contract

A queued upload whose client has gone leaves the queue at once: its handler answers and its job is dropped without a worker's turn, so the next queued upload moves up and no slot's time is spent on a request nobody waits for.

## What to do

When the feed records a body failure while the job is still queued, the handler returns at once with the check 62 item's answer (400 `upload_incomplete`, one INFO line) and removes the job through one lane call that removes it only while it is still queued, under the lane's lock, so the removal cannot race a promotion (a job promoted first runs to its own end as an active job does); an active job keeps the check 62 item's behaviour (the handler waits for the job's own end so the atomic writer's discard and the slot release stay the lane's). The lane's timing for active uploads is not changed.

## Boundaries

The transfer protocol, the lane's capacity and its cancel for active jobs are not changed; the check 62 item's answer and log line are reused, not redefined; the terminal and standalone Files lanes share the function and take the same change.

## Acceptance

1. Red first: two uploads holding the slots with open bodies, a third queued and then closed by its client (its body small enough that the feed is still reading when the client closes), a fourth queued behind it: at the tip the third's answer comes only when a slot frees and the fourth is announced at the position behind it; with the repair the third answers at once with 400 `upload_incomplete`, the fourth's announced position moves up by one, and when the next slot frees the fourth is promoted first, asserted by the order of the answers and the announced positions, not by latency (one mutant: the early return removed, red on the fourth's position).
2. The queued job leaves no partial file and releases nothing it did not hold (the lane's counters read before and after).
3. The whole `chan-server` suite green at two threads at the landed tip; check 62's queue legs run under Hygiene107's edited assertion.

## The owner's word 2026-10-16

Asked at the cut through one survey that listed the thirteen rows not shipped and the seven findings outside any item, with the lead's recommendation on each, and offered each row's own question with its cost (this row's line: "upslot, a queued upload whose client gave up: carry as one item with the explicit cancel"), the owner answered: "Take all fourteen recommendations as listed (Recommended)". The row moves to v0.108.0 at the GA commit as one item whose repair is an explicit cancel of a tracked transfer (protocol and page), with the promotion to running announced beside it; the narrow repair in What to do is superseded, and its record is the runtime seat's design note and the review seat's read of it (`reports/design-Runtime107-upslot.md`, `reviews/review-Review107-88-upslot-design.md` in the round's bus).
