# The whole-body disconnect test peeks for EOF before the server has read the terminating chunk

Status: raised for v0.110.0 on 2026-10-24 by the lead, from a red `make ci-macos` on `main`; not started.

## What was seen

CI run 40133561018 on `main` at `840c4f594`, a one-line documents commit over the v0.109.0 commit `53873f50e` whose own run 40122285377 was green on the same tree, failed `make ci-macos` in one test of `chan-server`: `routes::upload_incomplete_tests::socket_cancellation::a_whole_body_disconnect_drops_its_handler_and_registration` panicked at `crates/chan-server/src/routes/upload_socket_cancellation_tests.rs:310`, "observer must prove transport EOF, not unread socket bytes", left 1, right 0, with 2,403 tests passing beside it. The test's event log reads, for the target: `handler_entered`, `parsing_allowed`, `body_frame:1:bytes=142`, `pending:1`, the three queue frames, `client_aborted`, then the panic.

The whole-body variant of `experiment` writes the body's one chunk and then the terminating chunk `0\r\n\r\n` as separate writes, waits for the mark `target:pending:1`, shuts the client socket down and peeks the server side of the accepted socket, expecting 0. `Probe::wait` returns without yielding when the mark is already present, and the handler marks `pending:1` whenever its poll returns Pending with one frame counted: after the parse has ended and the writer waits for a slot, with the socket drained so that the peek reads EOF, and equally when hyper has read the first chunk before the terminator arrived, with five bytes still unread for the peek to find. The mark does not separate the two orders, and nothing else in the test orders the server's read of the terminator before the peek. The buffered variant has the same shape at its last chunk's trailing CRLF and passed in the same run. The commit that brought the test, `3d600182c`, records three timing failures retained under contention with isolated reruns green.

## Desired contract

The test's EOF proof runs after the server has consumed every byte the client wrote, in either scheduling order, so that a red of this assertion means bytes the product left unread and not a read that had not happened yet.

## What to do

A reading first, in the test: which event can mark that the body stream has ended for the target (the parser's end of body, or the writer's wait for a slot), and whether the early Pending and the late one can be told apart by the frame counter or need a mark of their own. Then the ordering point: a mark the handler sets when the body stream yields its end, awaited before the shutdown and the peek, or an equivalent the reading finds, for both variants. Pin it by forcing both orders in the harness, the terminator held back until after the handler's first Pending and the terminator written together with the chunk, and show the assertion red in the first order at the current test and green in both at the repair.

## Boundaries

`crates/chan-server/src/routes/upload_socket_cancellation_tests.rs` and its harness. Not changed: `routes/files.rs`, the transfer lane, the cancel route, the product's behaviour on a client disconnect.

## Acceptance

1. The forced early-read order fails the current assertion and passes at the repair; the forced late-read order passes at both.
2. `cargo test -p chan-server --all-targets` green on the Linux and the macOS arms of CI at the commit, with no product file in the change.
