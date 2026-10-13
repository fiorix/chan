# Fourteen route handlers announce a stored mutation after an await a client's early close can cancel

Status: raised by the runtime seat on 2026-10-13 from its read-only audit beside the session announcement repair (`reports/sessann-route-audit-Runtime106.md` in the round's bus); written down the same day by the lead as a row of its own; owner the runtime seat; not reached in the v0.106.0 round

## What was seen

Read at source, not run, under `crates/chan-server/src/routes/`, and read again by the review seat for five of them (`reviews/review-Review106-sessann-1.md` in the round's bus): fourteen handlers perform their mutation as a blocking task and announce it afterwards in the handler, so a client whose connection closes between the request and the answer leaves the mutation done and its announcement dropped with the cancelled handler, the shape repaired for the session routes by the row `sessann`. The drafts routes (`drafts.rs`: create, create diagram, discard, promote, each with its tagged `draft` event after the await), the draft-root arms of the attachment post (`attachments.rs`) and the file write (`files.rs`, after the body is accepted and the consumer publishes), and the standalone routes that commit an attributed mutation ticket after the await (`standalone_fs.rs`: create, delete, write, move; `standalone_drafts.rs`: create draft, create diagram, discard, promote; a supplied nonblank window id attributes the mutation, and dropping the ticket with the handler loses the attributed frames). Checked and found without the gap: the config patch, the open route, the standalone uploads and transfers, the local colour and theme setters, the terminal broadcast command, the window, handover and survey replies, the socket join, the excluded-directory and semantic-index routes, the reports toggle, and the document and scene sockets, each announcing inside its blocking closure or synchronously with no awaited mutation before it.

Two ways reach them without a page close, by the review's reading: the page's own ten-second request timeout aborts every call made through the client's request helper (the draft and diagram create, the discard, the promote, the file create, delete and move, on both mounts: eleven of the fourteen), so a mutation slower than ten seconds reports a timeout to its own page, finishes on the server and is never announced; and a terminal tab's teardown discards its Rich Prompt draft without waiting, so a window closed with that tab has the discard in flight. The six workspace draft handlers come first: a `draft` frame is the only thing that makes another window read the list again, move a promoted draft's tab or raise the changed banner, and no watcher stands behind the drafts store; the eight standalone handlers lose less, since the dropped ticket removes its own suppression and an OS echo after the drop surfaces unattributed.

## Desired contract

A mutation the server completes is announced to the pages that watch it whether or not the client that asked is still connected: each mutation and its announcement are one unit, as the session routes now are.

## What to do

Carry each successful mutation and its announcement in the same worker, as the session routes do; keep the mutation ticket's ownership there for the standalone routes; one row per handler that drops the request once the write has started and still reads the frame, red first. Design read before code; the fourteen are one pattern, so one form fits them.

## Boundaries

The fourteen handlers and their tests; the shared blocking helper only if it needs a form that carries the announcement. Not changed: the session routes (landed).

## Acceptance

1. The decision recorded here.
2. If built: each row red first with the write stored and no frame, green after, with one mutant; the whole `chan-server` suite, fmt and clippy green at the commit.
