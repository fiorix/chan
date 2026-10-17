# Fourteen route handlers announce a stored mutation after an await a client's early close can cancel

Status: shipped in [v0.107.0](../../release/release-v0.107.0.md).

Record before the release: built on 2026-10-16 on the seat's branch; the section A mutation and its announcement are one unit holds the evidence; it closes at the GA as shipped.

Record before the release: raised by the runtime seat on 2026-10-13 from its read-only audit beside the session announcement repair (`reports/sessann-route-audit-Runtime106.md` in the round's bus); written down the same day by the lead as a row of its own; owner the runtime seat; not reached in the v0.106.0 round

## What was seen

Read at source, not run, under `crates/chan-server/src/routes/`, and read again by the review seat for five of them (`reviews/review-Review106-sessann-1.md` in the round's bus): fourteen handlers perform their mutation as a blocking task and announce it afterwards in the handler, so a client whose connection closes between the request and the answer leaves the mutation done and its announcement dropped with the cancelled handler, the shape repaired for the session routes by the row `sessann`. The drafts routes (`drafts.rs`: create, create diagram, discard, promote, each with its tagged `draft` event after the await), the draft-root arms of the attachment post (`attachments.rs`) and the file write (`files.rs`, after the body is accepted and the consumer publishes), and the standalone routes that commit an attributed mutation ticket after the await (`standalone_fs.rs`: create, delete, write, move; `standalone_drafts.rs`: create draft, create diagram, discard, promote; a supplied nonblank window id attributes the mutation, and dropping the ticket with the handler loses the attributed frames). Checked and found without the gap: the config patch, the open route, the standalone uploads and transfers, the local colour and theme setters, the terminal broadcast command, the window, handover and survey replies, the socket join, the excluded-directory and semantic-index routes, the reports toggle, and the document and scene sockets, each announcing inside its blocking closure or synchronously with no awaited mutation before it.

Two ways reach them without a page close, by the review's reading: the page's own ten-second request timeout aborts every call made through the client's request helper (the draft and diagram create, the discard, the promote, the file create, delete and move, on both mounts: eleven of the fourteen), so a mutation slower than ten seconds reports a timeout to its own page, finishes on the server and is never announced; and a terminal tab's teardown discards its Rich Prompt draft without waiting, so a window closed with that tab has the discard in flight. The six workspace draft handlers come first: a `draft` frame, or a socket resync for the list alone, is what makes another window read the list again, and only the frame moves a promoted draft's tab or raises the banner, and the review knows of no watcher behind the drafts store; the eight standalone handlers lose less, since the dropped ticket removes its own suppression and an OS echo after the drop surfaces unattributed.

## Desired contract

A mutation the server completes is announced to the pages that watch it whether or not the client that asked is still connected: each mutation and its announcement are one unit, as the session routes now are.

## What to do

Carry each successful mutation and its announcement in the same worker, as the session routes do; keep the mutation ticket's ownership there for the standalone routes; one row per handler that drops the request once the write has started and still reads the frame, red first. Design read before code; the fourteen are one pattern, so one form fits them.

## Boundaries

The fourteen handlers and their tests; the shared blocking helper only if it needs a form that carries the announcement. Not changed: the session routes (landed).

## Acceptance

1. The decision recorded here.
2. If built: each row red first with the write stored and no frame, green after, with one mutant; the whole `chan-server` suite, fmt and clippy green at the commit.

## A mutation and its announcement are one unit 2026-10-16

The decision, as the lead ruled on 2026-10-16 on the runtime seat's design note (`reports/design-Runtime107-annaft.md`) and the review seat's read of it (`reviews/review-Review107-75-annaft-design.md`, both in the round's bus): each of the fourteen announces from the worker that stores, after its store succeeds, as the session routes do, with no new helper and `run_blocking` unchanged. A spawned task that awaits the worker and announces was declined as a second place for the same fact.

Built on the runtime seat's branch on top of `ac02f62cd`. `run_blocking` is `spawn_blocking(f).await`, so a dropped handler leaves its worker storing while the code after the await, where each of the fourteen announced, never runs.
- The six workspace handlers (the draft and diagram create, the discard and the promote in `drafts.rs`, the attachment's draft arm, `write_draft_file`) take a clone of the events sender and the window id into the closure. They send their `draft` frame there, after the store, as the closure's last act on success.
- The eight standalone handlers (create, delete, write and move in `standalone_fs.rs`; the shared draft and diagram create, the discard and the promote in `standalone_drafts.rs`) open their mutation ticket in the handler before the first disk syscall and move it with the Files state into the closure, which commits it on success and cancels it on failure.
- Answers, frames and their order relative to the answer are unchanged. Both `crates/chan-server/design.md` paragraphs state the contract: the "Standalone mutation attribution" paragraph in the review seat's words, one lifetime for a ticket the worker owns.
- A test seam (`routes/announce_hold.rs`, `cfg(test)`) holds a worker after its store and before its announcement, keyed by the request's window id.

The evidence is under `evidence/Runtime107/annaft/` in the round's bus, every run in the seat's guest as `ubuntu` with two cargo jobs and two test threads and `RUSTFLAGS=-Dwarnings`:

- Red at `ac02f62cd`, with the seam in its base form at the end of each worker's success path (`red-construction/`, `red-driver.log`, `runs/red/`): `cargo test -p chan-server --lib routes::announce_tests` exits 101 with 14 passed and 14 failed. Each pin holds its request after the store, sees the store done and no frame yet, aborts the request and sees it cancelled, and releases. All fourteen fail on "a stored change lost its announcement after request cancellation". All fourteen controls (the same request answered, its frames once) pass.
- Green after the repair (`green-driver.log`, `runs/green/`): `cargo fmt` (its diff brought back to the branch) and `cargo clippy -p chan-server --all-targets -- -D warnings` exit 0. The route modules' tests (`routes::announce_tests`, `drafts`, `attachments`, `standalone_fs`, `standalone_drafts`, `files`) pass, 260, the 28 new among them. Each pin and control decides "once" by an immediate `try_recv` once its frames have arrived, since the worker sends in one synchronous call and the cancelled handler is gone before the release. The standalone pins read only frames attributed to the request's window.
- Mutants, one per handler, its announcement removed from the worker (the workspace send made a no-op, the standalone commit given no ticket), each run alone with its pin and judged by the verdict reader that first refuses five constructed invalid observations (`mutants-driver.log`, `runs/mutants/`). The standalone create site serves two handlers and runs against both pins: fourteen runs over thirteen sites, each red at its pin on "a stored change lost its announcement after request cancellation" on the first attempt, the verdict reader rc 0.
- The gate at `d22fb493a`, this commit's code (`gate.sh`, `gate-driver.log`, `runs/gate/`): `cargo fmt --check`; `RUSTFLAGS="-D warnings" cargo clippy -p chan-server --all-targets -- -D warnings`; `cargo test -p chan-server --all-targets -- --test-threads=2`, 2,311 passed and 1 ignored over two binaries; `make check-windows-test-target` over chan-workspace, chan-server, chan-library and chan-desktop for `x86_64-pc-windows-gnu`. Every step exits 0 on the first attempt. The row and the message then took this bullet and the gate's counts, and nothing else.

Seen and named, outside the row's contract:
- A store that lands before a later step fails answers an error with no frame, at the base and the tip alike: the workspace create whose directory sync fails after its rename, the standalone write whose trailing stat fails, the standalone draft create whose primary write fails after its directory.
- A page that aborts a request at its ten-second timeout reports the timeout to its user while the server completes the mutation and now announces it. That is the page's, in the lead's ledger for the frontend seat.
- The cost of the repair: a standalone worker blocked on its disk keeps its paths' echo allowances and its directory's temporary-name suppression for as long as it blocks. That is the in-flight rule the ticket states, pinned by `an_aged_in_flight_ticket_still_attributes_its_commit`.

Acceptance 1 is the decision above. Acceptance 2 is the fourteen pins, red first with the write stored and no frame and green after, the fourteen mutants, and the whole `chan-server` suite, fmt and clippy green at the commit.
