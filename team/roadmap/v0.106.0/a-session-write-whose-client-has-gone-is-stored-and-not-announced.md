# A session write whose client has gone is stored and not announced

Status: raised by the review seat on 2026-10-13 from its read of check 150's release (C1 and P1 of `reviews/review-Review106-chk150-release-1.md` in the round's bus); written down the same day by the lead as a row of its own; owner the runtime seat; a repair ordered in the round with the review's proposal as its design

## What was seen

`api_put_session` (`crates/chan-server/src/routes/sessions.rs` 138 to 148) awaits the write, which runs as a blocking task (175 to 181; `routes/mod.rs` 97 to 101), and broadcasts `session_changed` after that await; `api_delete_session` (184 to 195) has the same shape. When the client's connection closes after the request is received and before the answer is written, the blocking write finishes and the handler does not run past its await: the layout is stored and no page is told. Shown on the server alone by the review seat (`evidence/Review106/sessput-disconnect-1` in the round's bus; raw HTTP/1.1 PUTs, each to its own window id, frames counted on a socket of the page's event bus): five writes that waited for their answer each 204, stored, one frame; twenty-four whose socket was destroyed after the request was handed over: at 0 ms not stored and no frame (4 of 4), at 1, 2, 5 and 10 ms stored with no frame (16 of 16), at 20 ms 3 of 4 stored with no frame. Another page on the same window id acts only on the frame (`store.svelte.ts` 3524 to 3548), so it keeps the older layout and its next save overwrites what was stored. In the browser suite, check 150 meets it: its co-viewer page closes right after its selection, the selection's save leaves as the live page's own request (the sync refetch flushes a pending save at once), the browser cancels the request with the page, and the source page never reads the session (`sourceGets=0`): red 3 runs of 23 at the integration tip in the review's guest, every red leg a stored and unannounced write (11 of 11 in the marked runs), and green 32 of 32 with the close moved after the settle. The wait was added on 2026-10-10 and was unreachable from the terminal-tab click repair until check 150's release repair.

## Desired contract

A session write the server stores is announced to the window's other pages whether or not the client that sent it is still connected: a write and its announcement are one unit.

## What to do

Make the announcement part of what cannot be cancelled: announce from inside the blocking task's success arm, or spawn the write and the announcement as one task and await its handle; both routes (the PUT and the DELETE). The review seat's proposal is the design read; the runtime seat picks the form and names its reason. Then the pin, red first: a server row that drops the request once the write has started and still reads the frame. Read the other routes that announce after an await for the same shape; list them in the hand-back and repair none in this version.

## Boundaries

`crates/chan-server/src/routes/sessions.rs` and its tests; `routes/mod.rs` only if the blocking helper needs a form that carries the announcement. Not changed: the store's save (the row `exitfl`); check 150.

## Acceptance

1. The row red at the tip before the repair (the dropped request's write stored, no frame) and green after, with one mutant.
2. `cargo fmt --check`, clippy with all targets and the whole `chan-server` suite green at the commit in the owning guest.
3. Check 150 at an integration tip that carries the repair: a count alone that would show a red at the measured rate (24 runs or more) and the neighbours run, with the engine named; the settle's red gone, or its rate stated.
