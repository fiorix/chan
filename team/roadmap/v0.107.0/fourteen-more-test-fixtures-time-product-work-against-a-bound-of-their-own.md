# Fourteen more test fixtures time product work against a bound of their own

Status: raised on 2026-10-16 by the lead from the hygiene seat's uncut search for the server timing tests item, read at source by that seat; written down with each fixture's margin; built by the hygiene seat after that item; owner the hygiene seat.

## What was seen

The server timing tests item's search (`dev/v0107-team/evidence/Hygiene107/svrtim/search.md`, every test line in `chan-server` and `chan-library` at `fd1f8a881` with a `Duration` within three lines of a deadline term, 250 rows in 248 groups; a second pass over every reader of the two route bounds, of `mount_timeout` and of `execute_mount_attempt`'s literal bounds) found seventeen fixtures that size a wait of their own against product work on the wall clock. Five are that item's, and two more of the seventeen are handled beside it (15318 repaired with its restore test, 9128 measured and recorded). The remaining ten, the two restore-bound fixtures the rule's three-line window missed, and the two attempt-bound fixtures the second pass found, fourteen in all, are these, each read at source by the hygiene seat:

- `chan-library` `host.rs` 10948 `already_open_mount_retries_a_transitional_lock` and 11384 `a_waiting_open_uses_its_own_cancellation_and_configuration`: a retried or waiting real open must mount inside a test-set open release budget of 10 s, or the host answers "still releasing"; a wide margin, the comment naming the risk.
- `host.rs` 12732 `a_relinked_close_keeps_both_keys_closing_during_off_by_either_path` and 12786 `a_devserver_clear_preserves_both_keys_of_another_close`: `relinked_fixture` sets the shutdown release budget to 5 s, and two offs bounded at 2.5 s each must run, with `!closing.is_finished()` holding, before it ends, or the held close takes its expired path.
- `chan-server` `devserver.rs` 13677 `held_close_for_devserver_clear` and its three callers 13734, 13789 and 13839: the helper sets the shutdown release budget to 5 s and returns a close held in `Closing`; each caller's product calls and `Closing` assertions must land before those 5 s end.
- `devserver_handoff.rs` 1188 `registration_with_delayed_reply`: a 2 s client budget against a 300 ms stub delay; if the accept and the delay outlast 2 s the client answers `ReplyTimedOut`.
- `handoff.rs` 2035 `assert_client_socket_gate`: the stub server accepts for 100 ms only, inside which the product client's socket checks and connect must land, or the client ends `NoDesktop` after its 3 s read window.
- `devserver.rs` 10493 `each_row_has_its_own_outcome_whichever_settles_first`: two healthy rows must mount inside `prepared_restore`'s 5 s bound beside a hung row; and 10741 `ready_wait_beside_held_rows`: a 1 s late hold must keep the restore alive past `READY_BOUND`'s 2 s wait (a bound local to that test), with the elapsed time asserted under `READY_BOUND` plus 1.5 s.
- `devserver.rs` 9452 and 11892: an attempt's 3 s bound passed to `execute_mount_attempt` must outlast the path to a held open and a library removal (9452), or let the attempt resolve its root (11892), each failing on a fixture message when it does not.

Beside them, forty tight hang guards (5 s or less around a workspace open, a spawned process, an HTTP app or a stream) fail only as hangs and do not change the product's path; they are listed in the search and not repaired here. The search's rule does not reach counted poll loops, `recv_timeout`, a sleep inside `select!`, or a constant defined away from its use; the item's closing section counts those shapes with a positive control each.

None of the fourteen has gone red in this round's runs; they share the server timing tests item's shape, and the same load can erase their margins.

## Desired contract

As the server timing tests item states it: where the product offers an ordering event, the fixture waits for the event; where it does not, the margin is stated in the test, sized by a measurement under a CPU cap and measured by the same loop, with the rate recorded. A contended run reports the product's state, never a refusal to measure; no test is ignored, serialized away or given a wider product bound.

## What to do

Read the fourteen fixtures whole. For each: name the event if the product offers one, else state the margin as a named constant in the test, measure it under the cap (the item's instrument: an sdme guest at `cpu.max 20000 100000` beside a parallel build, twenty runs with the probe's values per run) and size it by the item's rule (three times the slowest, 250 ms steps; a test-set product budget such as the open release budget or the shutdown budget is the fixture's to move, the product's defaults untouched). A margin a dependent crate's test cannot move (chan-library's `WORKSPACE_OPEN_RELEASE_TIMEOUT` override is compiled for its own tests only) is stated as a ceiling and ordered against, as the server timing tests item does for the restore tests. The forty tight hang guards stay as they are.

## Boundaries

The product's bounds and defaults are not changed; the fixtures keep their shapes, names and assertions; no test is ignored or moved to a serial group; the server timing tests item's five tests and the two it sized beside them are not touched again here.

## Acceptance

1. Each of the fourteen measured under the cap, twenty runs, the rate and the probe's values recorded; a test green twenty of twenty under the cap is sized from its measured margin and its runs are its reading, as the server timing tests item rules; a red one is green twenty of twenty under the same cap after its event or its sized margin.
2. Each test still red on the product behaviour it pins (one mutant each, red, restored).
3. The whole `chan-server` and `chan-library` suites green at two threads in the integration guest at the landed tip, and `ci-linux` green at the next `ci.yml` dispatch.
4. The closing section holds the search's positive control (the fourteen found again by the same commands) and the counts of the shapes the rule does not reach.
