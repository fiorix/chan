# The whole-body disconnect test peeks for EOF before the server has read the terminating chunk

Status: shipped at [v0.110.0](../../release/release-v0.110.0.md); the section EOF ordering evidence holds the evidence.

Record before the release: built on 2026-10-25 on v0110/eofpek; the section EOF ordering evidence holds the evidence; it closes at the v0.110.0 GA.

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

## EOF ordering evidence 2026-10-25

The multipart field ends at its closing boundary without another poll of the raw HTTP body, so only the test harness can observe the raw stream's end. `target:pending:1` records that the server is waiting after its first frame but cannot distinguish whether hyper has read the terminating chunk. The harness wraps `body.into_data_stream()` with a lookahead that holds each target frame until it polls the inner stream past that frame, marks `target:body_stream_end` when the inner stream yields `None`, then releases the held frame. The whole-body client awaits that mark before shutting down and peeking the accepted socket. Both body variants force early and late read orders without a sleep. The buffered early order withholds the ninth chunk's trailing CRLF until after `target:pending:9`; hyper yields `target:body_frame:9` before that CRLF is written, which is the condition that makes this order possible.

The pins-only patch at `dev/v0110-team/evidence/Tests110/eofpek/pins-only.patch` has SHA-256 `39a2b1552f4ab8c078c2245074e4695ac545c90532abf76dedb112c1d5ce1824`. At that tree the two early orders fail the EOF assertion with left 1 and right 0, while both late orders pass (`pin-buffered-early-base.log` and `pins-base-remainder.log` in the same evidence directory). With the lookahead, all four orders pass (`pins-repair-v2.log`); in both whole-body runs `target:body_stream_end` precedes `target:client_aborted`. At the committed test code, `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` pass, and ten filtered `cargo test -p chan-server --all-targets socket_cancellation -- --test-threads=2` runs pass with four tests each (`gate-fmt.log`, `gate-clippy.log`, `gate-filtered-10.log`, with their `.status` files in the same evidence directory). These forced orders cover acceptance point 1.

At commit `fa2b9aa22af004dcc6dc9e57e50ebcfc9a3c3d38`, `cargo test -p chan-server --all-targets -- --test-threads=2` passes under concurrent load from the integration gate and another server suite: the library binary reports 2,469 passed, 0 failed and 1 ignored, including all four socket-cancellation pins, and the example target reports 0 passed and 0 failed (`dev/v0110-team/evidence/Tests110/eofpek/whole-loaded-1.log` and `.status`, 2026-10-25T00:24:56Z to 00:33:23Z, rc 0). The integration gate runs throughout this interval, from its web checks into `make ci-linux-build`; the other server suite starts during the interval and remains active at its end (`dev/v0110-team/evidence/Server110/lnopen/tip-a-suites.log`). The loaded run adds no memory-cap or OOM event at the 8 GiB guest limit (`dev/v0110-team/evidence/Lead110/cgroup/tests-task3-loaded-1.txt`).

The same whole command passes alone in a quiet window at that commit: the library binary reports 2,469 passed, 0 failed and 1 ignored, including the four pins, and the example target reports 0 passed and 0 failed (`dev/v0110-team/evidence/Tests110/eofpek/whole-quiet-1.log` and `.status`, 2026-10-25T01:37:40Z to 01:41:53Z, rc 0). The window grant holds the other guest jobs through this run (`dev/v0110-team/followups/followup-Lead110-Tests110-1.md`). The loaded and quiet Linux suites supply the local Linux evidence for acceptance point 2; the full gate at the final tip and the macOS `ci.yml` arm remain pending.
