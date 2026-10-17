# Server timing tests go red under load

Status: shipped in [v0.107.0](../../release/release-v0.107.0.md).

Record before the release: built on 2026-10-16 on the seat's branch; the section Built and measured 2026-10-16 holds the evidence; it closes at the GA as shipped.

## What was seen

In the integration guest (4 CPUs, 12 GiB) at `cae9c5241`, `cargo test -p chan-server --all-targets -- --test-threads=4` ended with the lib binary at 2253 passed, 3 failed, 1 ignored (`dev/v0107-team/evidence/Lead107/int/gate-nonutf-landed/`), while two other guests built. The same lib suite once more and each of the three tests alone twenty times, in the same guest with the other guests quieter, were green 61 of 61 (`int/gate-server-rerun/`, each loop run's result line in `rerun-results.txt`). The control, the same lib suite at the base `e11541f6a` while two guests built, ended at 2255 passed, 1 failed (`int/gate-server-base-control/`): a fourth test of the same shape, the three green. Read over each lib binary's own run (`evidence/Lead107/pressure-watch-1.log`, 30 s samples; each window from the step's end line in its `gate.log` and the binary's own "finished in"), the host's CPU pressure, some avg10, peaked at 31.2 in the red tip run, 0.22 in the green rerun, 51.7 in the red base control and 6.5 in the red four-crate gate. The guest's quota throttled no period in any of them (`cgroup-before.txt` and `cgroup-after.txt` beside each gate; the whole gates' 2.0, 3.3 and 0.3 percent are their builds'). The guest's swap was highest in the green run. Every red came from a whole-suite run at four threads beside some host CPU pressure; the one whole-suite run under a quiet host was green; the isolated loops stayed green under more pressure. Four runs do not settle a cause: the suite's own load at four threads, with host contention beside it, is the hypothesis the acceptance's cap measures. The five, read at source at `5b6c26152`:

- `devserver::tests::a_registration_beside_an_expired_restore_holds_no_second_thread` (`crates/chan-server/src/devserver.rs` 15360): the restore registers two roots under one deadline, the state's mount timeout, which the test sets to 500 ms (the product's is `WORKSPACE_MOUNT_TIMEOUT`, 60 s); the fixture stalls one root inside its registration. Under the load the healthy root's registration missed the shared deadline too (the log's "did not answer within 1 seconds" is the 500 ms rounded up to whole seconds), the restore kept neither row and the first assertion failed: "the restore did not skip the hung root alone". The margin is the fixture's own 500 ms for a healthy registration.
- `routes::storage::tests::a_reset_beside_a_drop_that_outlasts_its_wait_for_the_lock_answers_busy_with_a_cell` (`crates/chan-server/src/routes/storage.rs` 1349): the route's lock wait is 500 ms under `cfg(test)` (`RESET_DRAIN_DEADLINE`; 5 s in the product). The late owner lets go three fifths of a bound after the route drops its own reference and its drop is timed at three halves of the bound, so the lock frees 250 ms past the route's wait for it and 250 ms inside the reopen's bound. Under the load the drop ended past the reopen's bound too and the route answered 500 with no workspace where 409 over a reopened one was expected.
- `routes::storage::tests::an_import_beside_a_reference_let_go_after_its_drop_completes` (`routes/storage.rs` 1286): the late owner lets go after 150 ms (`LATE_REFERENCE_HOLD`), inside the owners' bound; the workspace's real drop, the index closed and the recovery worker joined, must then end inside the lock wait's 500 ms test bound (`IMPORT_DRAIN_DEADLINE`). Under the load the drop outlasted it: the import was refused over the lock and the reopen answered 409 busy over a new workspace (`same_workspace: Ok(false)`) where 200 was expected. Its sibling `a_reset_beside_a_reference_let_go_after_its_drop_completes` (1275) has the same fixture and margin.
- `devserver::tests::stranded_mount_build_recovers_once_the_handle_is_released` (`devserver.rs` 19777): the attempt runs the open under a one-second bound of the test's own (`time_bound_mount`), and the test waits three seconds for the stranded build's entry signal. Under the load the open had not reached the builder within its second, so the future was dropped and the entry never came; the three-second wait could only time out: "the first build did not take the release receiver: Elapsed". The margin is the attempt's one second for the open's path to the builder. The same test went red once in a v0.106.0 whole-suite run.
- `mcp_bridge::tests::mcp_import_flush_waits_for_the_replacement_workspace` (`crates/chan-server/src/mcp_bridge.rs` 601, the shared case `bridge_call_during_workspace_swap` at 481): the whole case runs under a 15 s `tokio::time::timeout` around a workspace swap, its flush and two bridge calls. In the four-crate gate at `0273c5853` (`int/gate-reexec-landed/`, the lib suite at four threads) the bound elapsed at its `unwrap` (592) while its reset sibling passed. The margin is the case's 15 s against the swap's product work.

Each test sizes a wait of its own against product work measured on the wall clock (a healthy registration, a workspace's drop, an open's path to its builder, a swap's flush), and a loaded run stretches that work past the wait, so the route, the restore, the attempt or the case takes the path the test does not expect. The count: three red in one whole-suite run at the integrated tip, none in sixty-one isolated runs since, one red of a fourth test in the base's whole-suite run, one red of a fifth in the next integrated tip's; the playbook's rule is that isolated counts do not certify a load-sensitive test, and the one-CPU series is the instrument.

Also seen, in the `chan` crate at `16ebb8d73` (`int/gate-rstrace-landed/`, the crate's suite at four threads): four `tests/revtunnel_e2e.rs` cases timed out on their mount `POST /api/devserver/workspaces` at the client's 10 s bound, each against its own spawned devserver, in a whole-crate run at four threads; the binary alone was green five times since (`int/gate-rstrace-rerun/`, twice at four threads and once at two at the tip; `int/gate-rstrace-base-control/`, twice at four threads at the base), so the four share the shape; they are recorded here beside the five and measured by the same cap in the closing section, outside acceptance 1 and the search's two crates, and the lead raises their own row if their rate under the cap is not zero.

Also seen in the seats' own gates at two threads under memory contention, once each and neither reproduced alone: `mcp_bridge::tests::mcp_import_flush_waits_for_the_replacement_workspace` at its 15 s guard (the rebuild skip item's gate, the guest swapping 1.4 GB beside a cap window) and `routes::graph::tests::unread_backlinks_stream_frees_its_pool_thread` at a 2 s wall-clock bound in `stream_bridge.rs` (the check 62 item's gate), the second a member for the fourteen-margins row's reading.

Not established: that any of the five goes red on GitHub's runner (`ci-linux` has been green at every tip this round); that any other `chan-server` test shares the shape (the search is part of the work).

## Desired contract

The five tests prove their contracts without a wall-clock margin that load can erase where the product offers an ordering event, and with a stated, sized and measured margin where it does not. The reset test orders the drop's release on the route's refusal over the held lock, an event the product offers, so its fixture holds no timing margin. The import pair, the restore test, the stranded test and the MCP flush case have no such event: their margins are the fixtures' own constants, stated in the test, sized by the measurement and measured by the one-CPU series with the rate recorded. A contended run reports the product's state, never a refusal to measure; no test is ignored, serialized away or given a wider product bound.

## What to do

Read the five fixtures, the route's two waits (`routes/metadata.rs` `held_past_release` and the reopen) and the restore (`devserver.rs` `register_restore_rows`) whole, then:

- the reset test, and its import sibling `an_import_beside_a_drop_that_outlasts_its_wait_for_the_lock_answers_busy_with_a_cell` (`routes/storage.rs` 1360), which shares its fixture and takes the same event (the lead's ruling of 2026-10-16): release the slow drop on the route's reset refused over the held lock, through a test `ResetWorkspaceOps` wrapping the real one (the fixture's `BesideAnotherProcess` already implements the trait) or a `cfg(test)` hook at the reopen's first refused open; not at `Release::LockNotFreed`, which races the reset that follows at once and can turn 409 into 200. The remaining wait is the writer lock's release inside the reopen's bound.
- the import pair: no product event exists (the route reaches `chan-workspace` only after the owner is gone, so a fixture waiting for that call would wait out the owners' bound and answer busy over the same workspace). The margin is the real drop inside the lock wait's `cfg(test)` bound: state it in the test, measure the drop's length and the red rate under the cap, and size the `cfg(test)` bound if the measurement says so, within the Boundaries.
- the restore test: the shared deadline is the fixture's 500 ms; state it as the margin for a healthy registration and size it (each added second costs the test a second, since the hung root waits the deadline out), or assert the kept rows from the registrations' answers rather than from the deadline.
- the stranded test: state the attempt's one second as the margin for the open's path to the builder and size it; the attempt still times out on a larger bound, since the build is held until the test releases it.
- the MCP flush case: state the 15 s whole-case bound as the margin for the swap, its flush and the two calls, and size it; the case's own assertions stay the pins. The widened reading under the cap shows the swap answering busy before its session close, by the route's count wait past its bound or by an owner that takes a reference after the count, which leaves the case waiting on its gate until the 15 s; so the case retries a busy answer before its session close as a client does, up to three times, and fails at once with its own message past them (the lead's ruling of 2026-10-16).
- the search: uncut, over `chan-server` and `chan-library`, for fixtures that time product work against a `cfg(test)` deadline constant, a constant of their own, or a whole-test `tokio::time::timeout` around product work (`from_millis` and `from_secs` beside `IMPORT_DRAIN_DEADLINE`, `RESET_DRAIN_DEADLINE`, `mount_timeout`, `time_bound_mount` and `tokio::time::timeout`), listed in the closing section with a one-line reading each; the ones with the same shape repaired here only if the repair is the same, otherwise raised.

## Boundaries

The product's bounds (the routes' 5 s, `WORKSPACE_MOUNT_TIMEOUT`) are not changed. The `cfg(test)` values of the routes' waits and the fixtures' own constants belong to the tests and may change with the measurement, each dependent re-derived (the reset test's three fifths and three halves follow the bound); a `cfg(test)` bound that would have to grow past 2 s goes back to the lead with the numbers before the change. The fixtures keep their shapes and names; `chan-server`'s lib suite stays one binary; no test is marked ignored or moved to a serial group; the release and reopen logic in `routes/metadata.rs` is not changed.

## Acceptance

1. Each of the five red first under a CPU cap (an sdme guest at `cpu.max 20000 100000` running them in a loop beside a parallel build, or the one-CPU series under its parallel instrument), the rate recorded, at least one red in twenty; then under the same cap with the repair: the reset test green twenty of twenty (an event repair); the restore test, the stranded test and the MCP flush case green twenty of twenty at their sized margins; the import pair measured at the frozen 500 ms first (the drop's length and the red rate under the cap over twenty runs), then green twenty of twenty at the bound the measurement sizes. A test green twenty of twenty under the cap is sized from its measured margin, its runs the reading (the lead's ruling of 2026-10-16).
2. The five tests still red on the product behaviour each pins: the restore keeping the hung root's row, the reset answering success over a workspace still dropping, the import answering busy beside a reference let go inside its bound, the stranded row not recovering once the handle is released, the bridge answering a call before the replacement's flush (one mutant each, red, restored).
3. The whole `chan-server` lib suite green at four threads in the integration guest at the landed tip, and `ci-linux` green at the next `ci.yml` dispatch.
4. The closing section holds the uncut search's count with its positive control (the five as the control), the reading of every other fixture it finds, and every loop's per-run result lines on the bus.

## Built and measured 2026-10-16

The item commit changes four test files and `reopen_released`'s signature; no product bound, branch or order changes, and `crates/chan-server/design.md` describes the routes' waits as they stay.

- The reset test and its import sibling (`routes/storage.rs` 1349 and 1360 at the base `fd1f8a881`) release the late owner's drop on an event. `reopen_released` takes the lock directory of the workspace the route let go (its two callers pass the one they hold; the parameter is unused outside the unix test build, under a lint attribute), and a `cfg(all(test, unix))` hook keyed by it, `on_test_reopen_refused`, in a map of its own beside `on_test_lock_wait`'s, fires at the reopen's first refusal over the held lock, before the reopen's deadline check, taken out of its map before it is called. The new `LateOwner::DropHeldUntilReopenRefused` lets go at once as the workspace's last owner and parks its drop until that hook. The route's lock wait then sees the lock held for its whole bound and ends on `LockNotFreed`, the operation is refused over the held lock, the reopen's first refusal releases the drop, and what remains inside the reopen's bound is the drops of `report`, `walk_filter` and `scope_policy`, `WorkspaceLock`'s drop and one 25 ms poll. `LetsGoIntoADropOf`, `SlowDrop::Timed`, `drain_bound`, `a_drop_past_the_lock_bound` and the three-fifths sleep had no reader left and are gone; `SlowDrop` is a struct. The fixture records the answer's body `error` and its `Retry-After`: the four busy tests (both `OutlastsTheRoute` tests and both event tests) assert the route's Busy by its body (`workspace busy:`), and the reset's two also by `Retry-After: 1`, since `Core(WorkspaceLocked)` is a 409 too and the import's Busy carries no header (a difference between the two routes' Busy answers that this item leaves as it is).
- The margins are stated in the tests and sized at three times the slowest uncut reading under the cap, rounded up to a 250 ms step: both routes' `cfg(test)` bound (`RESET_DRAIN_DEADLINE`, `IMPORT_DRAIN_DEADLINE`) 2000 ms, the design's ceiling rather than the rule's 6000 ms, by the lead's ruling of 2026-10-16 (windows 4 to 6, below); the restore test's `HEALTHY_REGISTRATION` 2500 ms; `registrations_of_a_hung_root_hold_one_blocking_thread`'s `TO_THE_HELD_STEP` 500 ms; the stranded test's `ATTEMPT_BOUND` 3250 ms (the fixture's own literal, outside the Boundaries' 2 s rule for the routes' bounds, by the lead's ruling of 2026-10-16; every run waits it out, about 2.25 s more than the 1 s it replaces), its entry wait the bound plus 2 s, and its release poll a stated 5 s deadline that fails with its own message ("the stranded handle's drop did not free the root within 5s"), above three times its slowest reading, which a green run never waits out. The MCP case's 15 s guard stays, above three times its slowest whole case. `startup_restore_restores_other_roots_while_one_hangs` (9128) is recorded and not repaired (its slowest healthy mount 2001 ms against its 5 s, 0 of 20 red in both windows).
- A ceiling found by the measurement: the restore test's later registration and `registrations_of_a_hung_root_hold_one_blocking_thread`'s retries assert "mount timed out", which holds only while their bound stays under chan-library's open release budget (`WORKSPACE_OPEN_RELEASE_TIMEOUT`, 1 s, `crates/chan-library/src/host.rs` 47): past it, `register_workspace_keyed` (`host.rs` 1976) answers a registration still waiting for the held registry-write permit as `WorkspaceAlreadyOpen`, and a dependent crate's tests cannot move that product bound. So each of the two tests takes two bounds (the lead's ruling of 2026-10-16): the margin phase its sized constant, and the expiring phase `EXPIRING_REGISTRATION_BOUND`, 500 ms, set back through `Arc::get_mut` before it, an ordering by construction (the devserver's bound starts first and is the shorter), not a margin.
- The MCP case retries a swap the route answers busy before its session close, up to three times 50 ms apart, the gate installed until an attempt reaches it, and a busy answer past the retries fails at once with its own message. The widened reading shows two ways to that answer: the route's first count wait passing the frozen 500 ms (18 of 40 runs, up to 1147 ms; window 1's 25 reds of 40 at the 15 s guard are this wait answering busy and leaving the case waiting on a gate the route never reaches), and the admission's re-check (`storage.rs` 253 to 261) after an owner took a reference with the count already at one (MCP reset run 12 of window 3), which no size of the bound removes. B is sized from the import pair alone (the lead's ruling of 2026-10-16). The case's `status == OK` (`mcp_bridge.rs` 570 at the base) rests on the route's owners' and lock waits, which read 0 ms in all 40 runs of window 3.

### The reds at the frozen bounds (cap window 1)

In `chan-v0107-hygiene` at `cpu.max 20000 100000` (memory 8G, disk 44G), from 2026-10-16T14:53Z to 15:09Z, each test alone twenty times beside a release build of `chan-workspace` in the same guest, with a print-only instrument, at `a2d536ed9` (the branch's base then; the four test files are byte-identical to `fd1f8a881`, whose `chan-workspace` adds the model-cache and orphaned-sidecar changes). Every run was throttled each period at 0.20 cores. Per-run lines: `dev/v0107-team/evidence/Hygiene107/svrtim/reds-results.txt`; summary `reds-summary.txt`; logs `artifacts-reds/`.

| Test (line at the base) | reds/20 | reading |
| --- | --- | --- |
| reset beside a drop past its lock wait (1349) | 3 | 500 with no cell; drop 760 to 1698 ms |
| import beside a drop past its lock wait (1360) | 4 | 500 with no cell; drop 760 to 5830 ms |
| import let go after its drop (1286) | 0 | drop 7 to 288 ms against 500 ms |
| reset let go after its drop (1275) | 1 | 409 over a new workspace; drop up to 818 ms |
| restore beside an expired restore (15372) | 4 | the healthy registration cut at 500 ms |
| hung root's registrations (15318) | 0 | wall 1.9 to 2.2 s |
| stranded mount build (19777) | 0 | open to the builder 263 to 763 ms against 1 s |
| MCP import flush (601) | 15 | green 2.6 s; reds cut at the 15 s guard |
| MCP reset flush (596) | 10 | green 1.6 s; reds cut at the 15 s guard |
| startup restore beside a hang (9128) | 0 | wall 5.6 to 6.3 s |

The import test (1286), the stranded test and 15318 stayed green twenty of twenty under the cap; by acceptance 1's sentence they are sized from their measured margins, their runs the reading.

### The widened reading and the sizes (cap window 3)

The same cap and load, from 2026-10-16T15:48:50Z to 16:02:19Z, at `fd1f8a881` with every bound under test widened tenfold (B 5 s, the restore fixtures' `mount_timeout` 5 s, the stranded attempt 10 s with its entry wait 12 s and release poll 2000 polls, the MCP guard 150 s; guest-only patches `evidence/Hygiene107/svrtim/arm/instrument-arm.patch` and `widen.patch`), so no reading is cut. Every run ran its one test and was throttled each period at 0.20 cores; per-run lines and logs in `artifacts-arm/svrtim/arm-loop-{a,b,c}/`, summary `arm-summary.txt`.

| Test | reds/20 | uncut reading, min/median/max ms |
| --- | --- | --- |
| import let go (1286) | 0 | owners 150/151/197; lock 0/70/159; count 0 |
| reset let go (1275) | 0 | owners 59/172/199; lock 2/84/301; count 0 |
| 9128 at its own 5 s | 0 | healthy mount 589/1392/2001 |
| restore (15372) | 20 | healthy registration 24/198/397 (red at the ceiling above) |
| 15318 | 20 | first registration to its held step 0/74/90 (the same) |
| stranded | 0 | open to builder 472/580/1081; release to open 133/287/492 |
| MCP reset | 1 | count 0/198/1147; owners 0; lock 0; case up to 3302 |
| MCP import | 0 | count 121/511/728; owners 0; lock 0; case up to 3798 |

### What the bound costs

Every test of the two route modules, the held-reset test in `lib.rs`, the MCP pair and the reset join-error test, each alone once in a frozen-bound and a widened binary at 2 CPUs with no load (`evidence/Hygiene107/svrtim/cost.log`, `artifacts-arm/svrtim/cost/results.txt`): fourteen tests wait one whole route bound when green (0.99 to 1.09 bounds), the reset pair waited 2.12 and 2.17 before the event and wait one each with it (the lock wait), and the other 29 wait none. With 16 bounds per suite run, each 250 ms step of B adds about 4 s of test time to the `chan-server` lib suite.

### The greens at the item commit (cap window 2)

The same cap, from 2026-10-16T16:39:51Z to 16:57:55Z, at the item commit `5c64577c6` with a print-only instrument (`evidence/Hygiene107/svrtim/w2/instrument-w2.patch`; no bound changed), each test alone twenty times beside the release build of `chan-workspace`; every run ran its one test and was throttled each period at 0.20 cores (per-run lines and logs `artifacts-w2/svrtim/w2-*/`, summary `w2-summary.txt`).

| Test | reds/20 | reading under the cap |
| --- | --- | --- |
| reset beside a drop past its lock wait (event) | 0 | lock wait held its whole 1000 ms; residue 95 to 303 ms |
| import beside a drop past its lock wait (event) | 0 | the same; residue 96 to 303 ms |
| reset let go after its drop | 0 | owners up to 197 ms; drop up to 245 ms |
| import let go after its drop | 1 | run 11: drop 1528 ms, past B; the rest up to 147 ms |
| restore beside an expired restore | 4 | healthy registration past 1250 ms in four; the rest 11 to 692 ms |
| hung root's registrations (15318) | 0 | path to the held step up to 92 ms against 500 ms |
| stranded mount build | 0 | open to builder up to 1185 ms; release to open up to 444 ms |
| startup restore beside a hang (9128) | 0 | healthy mount up to 1388 ms against 5 s |
| MCP reset flush | 0 | whole case up to 4.8 s; one swap retried (run 15, 409 at 2605 ms) |
| MCP import flush | 0 | whole case up to 3.4 s |

The reverse-tunnel four (`crates/chan/tests/revtunnel_e2e.rs`; the test binary at the commit, the `chan` binary it spawns rebuilt at the commit), each alone twenty times under the same cap, are green twenty of twenty each: `tunnel_status_uses_assigned_ports_and_keeps_two_requests_independent` (2.4 to 3.9 s a run), `tunnel_status_waits_for_ack_and_clears_on_client_end` (1.7 to 6.1 s), `udp_bad_specs_and_a_windowless_tunnel_are_refused_with_one_line` (1.5 to 6.6 s), `tunnel_status_retains_refusal_and_no_ack_timeout_until_seen` (14.0 to 17.9 s). Their rate under the cap is zero, so no row is raised for them.

The two short of twenty were sized by window 3, whose parallel build was in a lighter phase (82 mostly small crates in its first loop) than window 2's (45 heavy ones: candle-core, candle-nn, candle-transformers, tantivy). The two tails are a workspace's drop and a registration, IO that a heavy compile's writeback can stretch. They are measured again under a held heavy load below.

### The tail under a held heavy load (cap window 4) and the sizes

The same cap, from 2026-10-16T17:07:02Z to 17:17:08Z, at the item commit with the bounds under test widened (B 5 s, the restore's healthy registration 5 s) and per-step lines (guest-only `evidence/Hygiene107/svrtim/w4/instrument-w4.patch`). The load was held at one heavy phase: over a completed release build of `chan-workspace`, candle-core and tantivy cleaned and rebuilt through every loop, so each run met two heavy compiles. The sampler added the unit's io and memory pressure. 180 runs, every one green and uncut (`w4-analysis.txt`, by `w4/w4_analysis.py`; per-run lines `artifacts-w4/svrtim/w4-loop-{a,b}/`):

- **The import let-go test, sixty runs:** drop 12 to 458 ms; owners' wait 150 to 199 ms; lock wait up to 447 ms.
- **The reset let-go test, sixty runs:** drop 9 to 330 ms; owners' wait up to 297 ms; lock wait up to 345 ms. In every slow drop the time is spent before the recovery worker's join, in the index and the fields that drop before it. The join, the report writer and the lock record took 0 to 73 ms.
- **The restore test, sixty runs:** the healthy registration answered in all 60, 10 to 362 ms from the deadline's start. Most of it is the registry file's save, up to 361 ms. The key took up to 99 ms; the permit and the blocking call's queue took 0 in all 60.
- **IO stall over a run** (the unit's `io.pressure`, full): up to 984 ms. The host's pressure watch read alike over windows 2, 3 and 4 (CPU some avg10 median about 33).

By the rule window 4 gave B 1500 ms (three times 458 ms, rounded up to a 250 ms step) and `HEALTHY_REGISTRATION` 1250 ms (three times 362 ms, rounded up); window 5 ran at those sizes.

### Window 5 and the final sizes

The same cap and held load, from 2026-10-16T17:30:36Z to 17:32:31Z, at B 1500 ms and `HEALTHY_REGISTRATION` 1250 ms, with a print-only probe that also stamps the restore's deadline, what it does with each row, the permit's outcome and the registry mutex and save in absolute time (`w5/instrument-w5.patch`; `w5-analysis.txt`; per-run lines `artifacts-w5/svrtim/w5-loop-{a,b}/`). Sixty of sixty green, but two readings passed three times those sizes:

- Reset let-go run 17: the drop took 1971 ms (25 ms before the recovery join, 1323 ms between the join and the lock record's clear, that is the recovery driver, the report state, the walk filter and the scope policy, 624 ms after it at the flock's close; an IO full stall of 410 ms over the run). The route's lock wait gave up at 1501 ms (`not_freed`) with the lock still held; the run went green because the throttled route reached chan-workspace's reset only after the flock had closed, a schedule and not a margin.
- Restore run 19: the healthy registration took 806 ms, 804 ms of it the registry file's save (`fs_ops::atomic_write`, no file lock) with the registry mutex held. The deadline fired at 1298 ms; the restore skipped the hung row and kept the healthy one; the permit was taken in 0 ms against chan-library's 1000 ms budget in all twenty runs; nothing took the registry mutex or file at the deadline (the hung registration asked for the mutex only after the test released its stall, 1.8 s in).

By the rule B would be 6000 ms and `HEALTHY_REGISTRATION` 2500 ms. Chosen, by the lead's ruling of 2026-10-16: B at 2000 ms, the design's ceiling, since the rule's 6 s would add about 44 s of wall time to every `chan-server` suite run at two threads (16 tests wait B out) for a margin seen once under this instrument; at 2000 ms the cost against 500 ms is about 24 s of test time, about 12 s of wall. The residual is stated as measured: a drop past 2 s under a 0.2-CPU cap with a heavier IO stall; at 1500 ms the rate was 0 red of 60 with one run past B green by the schedule. `HEALTHY_REGISTRATION` at 2500 ms, three times 806 ms rounded up, half a second past the ceiling as a fixture constant, about 1.25 s more per run than 1250 ms.

The restore test's red mode at the short bounds (4 of 20 at 500 ms in window 1, 4 of 20 at 1250 ms in window 2; 0 of 80 at 5 s in windows 3 and 4; 0 of 20 at 1250 ms in window 5) reads as the registry save's tail under IO: the healthy registration's time is its own save, it carries no bound of its own from `mount_timeout`, and the deadline takes nothing when it fires. No red run carries the stamps, so this is a reading, not a proof.

### The greens at the final sizes (cap window 6)

The same cap and held load, from 2026-10-16T17:49:02Z to 17:51:20Z, at the final item commit with the same print-only probe (`w6/instrument-w6.patch`; `w6-analysis.txt`; per-run lines `artifacts-w6/svrtim/w6-loop-{a,b}/`), each test alone twenty times; every run ran its one test and was throttled each period at 0.20 cores:

| Test | reds/20 | reading under the cap |
| --- | --- | --- |
| import let go after its drop | 0 | drop 12 to 148 ms; lock wait up to 148 ms |
| reset let go after its drop | 0 | drop up to 1916 ms (one run), freed inside B |
| restore beside an expired restore | 0 | healthy registration 14 to 205 ms against 2500 ms |

The one long drop (1916 ms, all of it before the recovery worker's join, that is the index and the fields before it; an IO full stall of 535 ms over the run) ended 84 ms inside B at 2000 ms, and the route's lock wait saw the lock free. Across windows 2, 5 and 6 the drop's tail reached 1528, 1971 and 1916 ms, each time beside a heavy compile under the cap and at a different step of the drop: this is the measured residual the 2 s ceiling leaves, stated here as the lead's ruling asks.

### The mutants (acceptance 2)

At the item's first tree `5c64577c6` in the guest, at 2 CPUs (its tests differ from the final commit's only in the values of the two route bounds and the restore test's margin, and no mutant's red rests on those values): one product-code mutant per guard, built, each target test run alone once, then the tree restored and checked clean and equal to the commit (`evidence/Hygiene107/svrtim/mutants-1.{log,status}` rc 0; patches and their hashes in `mutants/`, made by `mutants/make_mutants.py` from the committed tree). Every one is red at its own assertion:

- The restore keeping the hung root's row (`register_restore_rows` keeps a row whose registration did not answer within the bound): `a_registration_beside_an_expired_restore_holds_no_second_thread` red, "the restore did not skip the hung root alone", both rows kept.
- A registration of a root taking a permit no other registration of it waits for (`register_workspace_keyed`'s registry-write permit keyed per call): `registrations_of_a_hung_root_hold_one_blocking_thread` red, "each expired registration held a thread", 3 where 1 is asserted.
- The reset answering success over a workspace still dropping, by the one route change that can answer success there, the lock wait unbounded (`held_past_release`'s `lock_deadline` an hour away; one site, shared by both routes): the reset test and its import sibling are both red at the fixture's guard, "the route neither reached its reopen refused over the held lock nor answered within 10s". The route waits on a lock the parked drop releases only at the reopen's refusal, which it never reaches, so it never answers busy with a cell; the variant's wait for that refusal, 10 s from the release of the route, expires before the drop gate's own 10 s, so the red is at the guard and not at a 200. "`LockNotFreed` read as `LetGo`" would answer 500 through `WorkspaceAlreadyOpen`, not success, and chan-workspace refuses the reset while the lock is held, so no route mutant answers 200 while the drop holds it.
- The import answering busy beside a reference let go inside its bound (`held_past_release`'s owners' wait cut to zero; one site for both routes): the import test and its reset sibling are both red, 409 "workspace busy: ..." over the same workspace where 200 over a new one is asserted.
- The stranded row not recovering once the handle is released (the host keeps a reference to every workspace it hands to its builder, `std::mem::forget` beside `build_workspace` in `crates/chan-library/src/host.rs`): `stranded_mount_build_recovers_once_the_handle_is_released` red at its own release deadline, "the stranded handle's drop did not free the root within 5s".
- The bridge answering a call before the replacement's flush (each route lets go of the cell's write guard across its session close, `perform_reset_with` and `perform_metadata_import_with`): `mcp_reset_flush_waits_for_the_replacement_workspace` and `mcp_import_flush_waits_for_the_replacement_workspace` each red at the case's guard assertion at the flush, "assertion failed: state.workspace_cell.try_read().is_err()".

### The own gate

At the final item commit `ce2fdbc8f` in the guest (2 CPUs, 8 GiB; the private checkout fetched from the branch, detached at the commit and clean before and after; `evidence/Hygiene107/svrtim/gate-3.{log,status}` rc 0, the guest's logs under `gate-3/`): `cargo fmt --check` 0; `cargo clippy --locked -p chan-server --all-targets -j2 -- -D warnings` 0; `cargo test --locked -p chan-server --all-targets -j2 -- --test-threads=2` 0, the lib suite 2258 passed, 0 failed, 1 ignored in 498 s. The same gate was green at the two trees before the size amends (`gate-1` at `5c64577c6`, `gate-2` at `923ac38b6`, each 2258 passed, 1 ignored). Linux only; no browser or native reading belongs to this item. Acceptance 3 (the lib suite at four threads in the integration guest at the landed tip, and `ci-linux` at the next `ci.yml` dispatch) is the lead's.
### The search

The rule as operationalized: every line of `crates/chan-server` and `crates/chan-library` with `Duration::from_millis(` or `Duration::from_secs(` on or within three lines of `IMPORT_DRAIN_DEADLINE`, `RESET_DRAIN_DEADLINE`, `mount_timeout`, `time_bound_mount`, `tokio::time::timeout` or `timeout_at`, grouped by its enclosing test or helper and read at source (the commands, raw counts and grouping are in `dev/v0107-team/evidence/Hygiene107/svrtim/search.md`; the proximity step is `arm/proximity.py`). At the base `fd1f8a881` it finds 394 lines, the same lines with the same text as at the tree it was first read on, ten `lib.rs` lines 19 further down (`arm/proximity-compare.txt`). They make 250 rows in 248 groups (the two not(test)/cfg(test) deadline pairs split into a product and a test row): 17 margins (M), 40 hang guards of 5 s or less around heavy real work (H-tight), 177 other hang guards (H), 7 event or negative waits (E) and 9 product rows (P).

The positive control holds in part. The restore test, the stranded test and the MCP case are found as groups (`devserver.rs` 15384 and 19835, `mcp_bridge.rs` 485). The reset test and the import pair are not: they reach their 500 ms bound through `drain_bound` and `LATE_REFERENCE_HOLD`, more than three lines from any term, and the rule finds only the bound's `cfg(test)` definitions (`routes/storage.rs` 76, `routes/metadata.rs` 162). A proximity rule misses a fixture that takes its wait through a helper; the second pass below closes that for the shapes this item names.

Every row, with its class, its values and a one-line reading (line numbers at `fd1f8a881`; the reading is of the fixture as it stands there):

- `crates/chan-library/src/host.rs:7169` `abandon_removal_at` (H; 5s): pool probe after releasing a held removal hop; light (no-op spawn_blocking)
- `crates/chan-library/src/host.rs:7269` `answer_or_give_up_soon` (H; 10s): helper: a caller answers or reaches the held hop; light
- `crates/chan-library/src/host.rs:8582` `mount_root_check_leaves_routing_unlocked` (H; 30s): whole-test guard over library setup, mount and close (comment: hang guard, not a latency bound)
- `crates/chan-library/src/host.rs:8660` `mount_publication_race` (H; 30s): whole-test guard over two real workspace opens
- `crates/chan-library/src/host.rs:8858` `a_mount_built_before_the_last_sweep_shuts_its_runtime_down` (H; 10s): guard over shutdown_all and a refused mount (fake builder)
- `crates/chan-library/src/host.rs:9672` `an_open_beside_an_abandoned_unregister_answers_still_releasing` (H; 10s): open beside a held unregister; product open_release_budget 40 ms expires on a test-held hop (deterministic)
- `crates/chan-library/src/host.rs:9705` `at_the_registry_gate` (H; 10s; 5ms step): helper: poll until the open takes its mount permit, then a fixed 100 ms settle sleep (settle, not a product bound)
- `crates/chan-library/src/host.rs:9760` `an_open_waits_for_a_registry_write_that_returns_inside_its_budget` (H; 10s): open mounts once the held registry write is dropped; product budget 60 s, so this guard fails first
- `crates/chan-library/src/host.rs:9810` `an_open_that_waited_for_an_unregister_finds_no_row` (H; 10s): same shape; product budget 60 s
- `crates/chan-library/src/host.rs:9879` `an_open_of_a_relinked_root_waits_for_the_unregister_of_its_row` (H; 10s): open beside the unregister of its row; budget 40 ms on a held hop (deterministic expiry)
- `crates/chan-library/src/host.rs:10182` `a_mounted_removal_refused_at_the_registry_permit_takes_the_workspace_down` (H; 10s): removal beside a held registry write; budget 40 ms held
- `crates/chan-library/src/host.rs:10288` `a_held_unregister_that_returns_leaves_no_overlay_row_of_a_refused_removal` (H; 10s): wait for the held unregister's permit after release; light
- `crates/chan-library/src/host.rs:10652` `a_removal_abandoned_at_a_held_unregister_purges_once_the_unregister_returns` (H; 10s): same shape for an abandoned removal's purge
- `crates/chan-library/src/host.rs:10838` `a_terminal_tenant_built_across_the_last_sweep_shuts_its_runtime_down` (H; 10s): whole-test guard over a terminal tenant build across the last sweep (fake builder)
- `crates/chan-library/src/host.rs:10867` `failed_remove_guard_settles_cancellation_and_unwind` (H; 30s): whole-test guard; registry file save
- `crates/chan-library/src/host.rs:10904` `failed_remove_reports_error_and_can_be_retried` (H; 30s): whole-test guard; real open and removal
- `crates/chan-library/src/host.rs:10948` `already_open_mount_retries_a_transitional_lock` (M; 30s guard; open_release_budget 10s (line 10958)): retried real open after a modelled 250 ms slow open must succeed inside the test-set 10 s release budget or the host answers still releasing and result.is_ok() fails; low (10 s), the comment names the risk
- `crates/chan-library/src/host.rs:10994` `cancelled_mount_does_not_open_after_release` (H; 30s): whole-test guard; real open and release
- `crates/chan-library/src/host.rs:11092` `a_removal_answers_while_an_abandoned_open_owns_the_writer_lock` (H-tight; 2s): remove_workspace_for_root (registry write) beside an abandoned open must answer inside 2 s; removal.is_ok() asserted
- `crates/chan-library/src/host.rs:11164` `a_retry_answers_beside_an_abandoned_open_that_holds_the_workspace` (H-tight; 5s; 2s; 2s): retry, close and remove beside an abandoned open that holds the workspace (test budget 200 ms on a held open: expiry deterministic); 2 s guards wrap close and remove with registry writes
- `crates/chan-library/src/host.rs:11271` `a_caller_waiting_for_the_mount_permit_shows_starting_and_settles_when_it_leaves` (H; 5s; 5ms step): poll until the waiting caller shows Starting (in-memory); its 10 s budget sits above this guard
- `crates/chan-library/src/host.rs:11384` `a_waiting_open_uses_its_own_cancellation_and_configuration` (M; 50ms; 10s; open_release_budget 10s (line 11357)): 50 ms is a negative wait (E); after release the waiting open must mount inside the test-set 10 s release budget, else it answers still releasing; low (10 s, equal to the guard)
- `crates/chan-library/src/host.rs:11410` `a_cancelled_open_releases_the_workspace_before_its_permit` (H; 30s): whole-test guard
- `crates/chan-library/src/host.rs:11502` `an_abandoned_open_result_releases_the_workspace_before_its_permit` (H; 30s): whole-test guard
- `crates/chan-library/src/host.rs:11704` `an_abandoned_revalidation_releases_the_workspace_before_its_permit` (H; 30s): whole-test guard (shutdown budget 50 ms on a held revalidation)
- `crates/chan-library/src/host.rs:11760` `an_abandoned_root_check_releases_the_workspace_before_its_permit` (H; 30s): whole-test guard
- `crates/chan-library/src/host.rs:11814` `the_public_open_resolves_its_key_before_it_builds_its_tenant` (H; 30s): whole-test guard
- `crates/chan-library/src/host.rs:11851` `an_open_of_a_mounted_root_returns_beside_an_abandoned_revalidation` (H; 60s; 5s): 60 s whole-test guard; 5 s on an open of a mounted root that must not wait for an abandoned revalidation (fake builder, light)
- `crates/chan-library/src/host.rs:11909` `already_open_mount_waits_for_an_in_process_release` (H; 30s): whole-test guard; comment: ordering asserted, not timed
- `crates/chan-library/src/host.rs:11953` `already_open_mount_reports_releasing_after_the_budget` (H; 30s): whole-test guard; budget asserted as a lower bound
- `crates/chan-library/src/host.rs:12017` `interrupted_mount_already_open_reports_releasing_and_allows_retry` (H; 30s): whole-test guard; budget 40 ms on a held root
- `crates/chan-library/src/host.rs:12078` `interrupted_mount_cancellation_settles_starting` (H; 30s): whole-test guard; gated builder orders the steps
- `crates/chan-library/src/host.rs:12137` `interrupted_mount_after_cancelled_close_never_stays_starting` (H; 30s): whole-test guard; budget 40 ms held
- `crates/chan-library/src/host.rs:12419` `cancelled_close_clears_closing_and_persists_off` (H; 3s; 3s): select until tenant shutdown starts, then the feed notify; in-memory steps with a fake builder
- `crates/chan-library/src/host.rs:12595` `a_releasing_answer_writes_the_retry_row` (H; 10s; 10ms step): poll until the teardown ends after release (module BUDGET 40 ms)
- `crates/chan-library/src/host.rs:12732` `a_relinked_close_keeps_both_keys_closing_during_off_by_either_path` (M; 5s; 1ms step; 10s; shutdown budget 5s (line 12678)): relinked_fixture sets the shutdown release budget to 5 s; two offs, each bounded by BOUND 2.5 s, must run and !closing.is_finished() must hold before it ends, else the held close takes its expired path; the 5 s poll and 10 s close wait are H
- `crates/chan-library/src/host.rs:12786` `a_devserver_clear_preserves_both_keys_of_another_close` (M; 5s; 1ms step; 10s; shutdown budget 5s (line 12678)): same relinked_fixture 5 s budget; asserts !closing.is_finished() around a devserver clear before it ends
- `crates/chan-library/src/host.rs:12845` `a_relinked_close_left_by_its_caller_clears_both_marks` (H; 10s): poll until both keys' teardown ends after release; light
- `crates/chan-library/src/host.rs:12865` `close_and_leave` (H; 10s; 1ms step): helper close_and_leave: the close reaches its cell's clear, then its caller leaves; light
- `crates/chan-library/src/host.rs:12942` `a_close_by_root_whose_teardown_is_held_records_its_off_and_reads_still_releasing` (H; 3s): feed notify after a refused close (module BUDGET 40 ms on a held clear); light
- `crates/chan-library/src/host.rs:12997` `an_off_beside_a_teardown_that_still_runs_answers_still_releasing_until_it_returns` (H; 10s): feed after release; light
- `crates/chan-library/src/host.rs:13139` `a_teardown_that_returns_tells_the_feed_and_leaves_a_row_written_since` (H; 3s): feed told after a teardown returns; light
- `crates/chan-library/src/host.rs:13188` `a_close_whose_workspace_another_owner_keeps_answers_still_releasing_until_it_lets_go` (H; 10s): feed after the other owner lets go
- `crates/chan-library/src/host.rs:13258` `an_open_beside_a_teardown_that_ends_mounts_once_it_has_returned` (H; 10s; 30s; 30s): late hop reaches its look; the open waits, then mounts once let go (budget 60 s)
- `crates/chan-library/src/host.rs:13338` `a_teardown_returns_beside_another_processs_lock_once_its_workspace_is_let_go` (H; 10s; 10s; 10ms step): late hop's look; teardown returns beside a foreign lock
- `crates/chan-library/src/host.rs:13385` `a_teardown_returns_once_its_workspace_is_let_go_and_its_lock_directory_is_gone` (H; 10s; 10s; 10ms step): teardown returns once the lock directory is gone, then restored
- `crates/chan-library/src/host.rs:13433` `a_teardown_keeps_its_permit_and_its_row_while_its_workspace_is_kept` (H; 10s; 10ms step): teardown returns once the workspace is let go
- `crates/chan-library/src/host.rs:13546` `a_close_answered_through_an_earlier_permit_clears_its_free_key` (H; 5s; 1ms step; 10s): later teardown reaches its held clear; clears after release (module BUDGET 40 ms; BOUND 2.5 s is on a non-hit line)
- `crates/chan-library/src/host.rs:13614` `an_off_beside_a_close_that_still_awaits_its_teardown_is_not_refused` (H; 10s; 1ms step; 10s): close reaches its clear; close answers after release
- `crates/chan-library/src/host.rs:13674` `a_close_by_prefix_marks_and_detaches_under_one_map_guard` (H; 10s; 10s): close enters its held teardown; answers after release
- `crates/chan-library/src/host.rs:13722` `a_close_by_prefix_preserves_a_late_unavailable_row` (H; 10s; 10s; 10s): same shape with a late unavailable row
- `crates/chan-library/src/host.rs:14079` `publication_accepts_a_terminal_inserted_during_the_build` (H; 10s): whole-test guard over a publication during a held root check
- `crates/chan-library/src/host.rs:14363` `closing_a_terminal_preserves_the_home_lifecycle` (H; 3s): select until terminal shutdown starts; in-memory with a fake builder
- `crates/chan-library/src/host.rs:14608` `a_relinked_open_refuses_after_its_captured_runtime_closes` (H; 10s; 30s; 30s; 2s; 30s): opener reaches its probe, close, waiting opener, newer open; 2 s is a cleanup join after abort
- `crates/chan-library/src/host.rs:14681` `an_open_does_not_hand_back_a_replacement_at_the_same_prefix_and_key` (H; 10s; 30s; 30s; 30s; 2s): same shape
- `crates/chan-library/src/host.rs:15197` `two_roots_racing_one_prefix_publish_one_and_release_the_other` (H; 60s): two racing opens of one prefix
- `crates/chan-library/src/host.rs:15717` `terminal_pruner_persists_a_reaped_window` (H-tight; 30s; 25ms step; 5s): 30 s for the detached shell to exit; 5 s for the pruner's first tick to reap and save windows.json (filesystem)
- `crates/chan-library/src/host.rs:17904` `a_registration_beside_a_removals_unregister_answers_retry` (H; 10s): removal reaches its held unregister
- `crates/chan-library/src/host.rs:18066` `a_publication_of_a_row_under_removal_answers_retry` (H; 10s): same
- `crates/chan-library/src/host.rs:18158` `a_refused_removal_reads_the_outstanding_unregister_not_the_rows_words` (H; 10s): poll claim_unregistered after release
- `crates/chan-library/src/session_presence.rs:1358` `install_change_notify_fires_on_reaper_leader_promotion` (H; 1s): change notify after a reaper leader promotion (in-memory)
- `crates/chan-library/src/tenant.rs:590` `owner_drop_cancels_and_aborts` (H; 1s): aborted task dropped after owner drop (in-memory)
- `crates/chan-library/src/terminal_sessions.rs:7777` `activity_event_fires_on_first_unfocused_output_and_clears_on_focus` (H; 1s; 1s; 1s): broadcast events after record_output and set_focused (in-memory)
- `crates/chan-library/src/terminal_sessions.rs:9371` `bracketed_paste_readiness_stops_when_the_session_closes` (H; 1s): bracketed-paste wait returns on session close (ring session, in-memory)
- `crates/chan-library/src/terminal_sessions.rs:9951` `imported_session_slave_close_is_a_clean_exit_not_an_error` (H; 10s): Exit event after an imported PTY slave closes
- `crates/chan-library/src/terminal_sessions.rs:11818` `two_attaches_share_io` (H-tight; 5s): deadline loop for a real shell's __SHARED__ output on a second attach
- `crates/chan-library/src/terminal_sessions.rs:11856` `request_redraw_broadcasts_current_size` (H; 5s): resize event after request_redraw (in-memory broadcast)
- `crates/chan-library/src/terminal_sessions/tests/control_socket_env_tests.rs:53` `inherited_control_bind_report_is_removed` (H; 30s): child test process
- `crates/chan-library/src/terminal_sessions/tests/program_status_tests.rs:1625` `status_query_fresh_controller_writes_both_terminators` (H; 10s): real shell status-query output
- `crates/chan-library/src/terminal_sessions/tests/program_status_tests.rs:1702` `status_query_restored_controller_wakes_without_a_tick` (H-tight; 5s): restored controller's real shell output
- `crates/chan-library/src/terminal_sessions/tests/program_status_tests/lifecycle.rs:64` `wait_records` (H-tight; 1s): helper asserts program-status records settle within 1 s after real shell job commands
- `crates/chan-library/src/terminal_sessions/tests/program_status_tests/lifecycle.rs:360` `status_fresh_exit_waits_for_a_report_already_read` (H-tight; 5s; 5s): recv_timeout for the entered signal, then the Exit event of a real shell
- `crates/chan-library/src/terminal_sessions/tests/program_status_tests/lifecycle.rs:455` `status_exit_event` (H-tight; 3s): helper: Exit event of a real PTY child
- `crates/chan-library/src/windows.rs:2259` `change_notify_wakes_a_waiter_on_create` (H; 1s): change notify after create (current-thread, in-memory)
- `crates/chan-server/src/bulk_transfer.rs:659` `assert_stalled_download_releases_slot` (H; 2s; 2s): lane slot freed after the product stall bound on an unpolled download; body error; light
- `crates/chan-server/src/bulk_transfer.rs:869` `a_saturated_lane_leaves_the_blocking_pool_free` (H; 200ms; 10s; 10s): 200 ms is a negative wait (pool must be full, E); 10 s guards on queued blocking tasks
- `crates/chan-server/src/control_socket.rs:1090` `serve_connection_parts` (P; 5s): serve_connection_parts: unserve reply write bound
- `crates/chan-server/src/control_socket.rs:6210` `a_failed_commit_answers_at_once_and_stops_the_export` (H; 2s): export task answers after mark_failed; light
- `crates/chan-server/src/control_socket.rs:6783` `control_request_deadline_case` (H; 15s; 1s; 10ms): 15 s whole-case guard; paused clock advanced 1 s then a 10 ms poll (E)
- `crates/chan-server/src/control_socket.rs:6840` `control_request_deadline_serves_an_immediate_request` (H; 3s): whole-test guard over a control socket start and one identify round trip; light
- `crates/chan-server/src/control_socket.rs:6857` `control_request_deadline_does_not_limit_a_parked_handover` (H; 15s): whole-case guard (parked handover)
- `crates/chan-server/src/control_socket.rs:6901` `control_unmount_ends_a_parked_handover` (H; 3s; 1s): whole-test guard; read after unmount ends a parked handover; light
- `crates/chan-server/src/control_socket.rs:7193` `a_control_close_whose_teardown_is_still_held_says_still_releasing` (H; 8s): handle_unserve beside a held teardown answers at the test-set 200 ms shutdown budget (held, deterministic); 8 s guard over a real route_builder host
- `crates/chan-server/src/control_socket.rs:7225` `control_close_reply_survives_its_own_unmount` (H; 3s): whole-test guard; FakeHost close reply
- `crates/chan-server/src/control_socket.rs:7595` `identify_beside_a_held_workspace_cell_waits_off_the_worker_and_answers_the_workspace` (H; 10s): Identify answers once the held cell is let go
- `crates/chan-server/src/control_socket.rs:10341` `recv_command` (H; 3s): helper: window command frame on a broadcast
- `crates/chan-server/src/control_socket.rs:10466` `cancel_on_eof_releases_an_open_survey_and_its_turn` (H; 3s): survey handler ends after client EOF
- `crates/chan-server/src/control_socket.rs:10516` `cancel_on_eof_clears_a_pending_handover` (H; 3s): handover handler ends after client EOF
- `crates/chan-server/src/control_socket.rs:10578` `missing_cancel_on_eof_keeps_a_half_closed_survey_alive` (H; 3s; 3s): response read and handler join
- `crates/chan-server/src/control_socket.rs:10636` `recv_survey_sync` (H; 5s): helper: survey sync frame relayed over /ws
- `crates/chan-server/src/control_socket.rs:10663` `recv_watch_resync` (H; 5s): helper: watch resync frame over /ws
- `crates/chan-server/src/control_socket.rs:10694` `recv_socket_command` (H; 5s): helper: socket command frame over /ws
- `crates/chan-server/src/control_socket.rs:10982` `an_untagged_socket_that_lags_gets_a_root_recovery_cue` (H; 5s): pong over /ws
- `crates/chan-server/src/control_socket.rs:11100` `a_socket_that_keeps_lagging_still_gets_its_broadcast_frames` (H; 10s): frames on a lagging socket
- `crates/chan-server/src/control_socket.rs:12528` `first_terminal_frame` (H; 30s): helper: first terminal frame
- `crates/chan-server/src/control_socket_diagnostics_tests.rs:33` `isolated_child` (H; 60s): child test process
- `crates/chan-server/src/control_socket_diagnostics_tests.rs:178` `serving_and_terminal` (H; 20s): real terminal output __DONE__
- `crates/chan-server/src/control_socket_request_status_tests.rs:87` `frame` (H; 10s): helper: command frame
- `crates/chan-server/src/control_socket_request_status_tests.rs:101` `response` (H; 40s): helper: response line
- `crates/chan-server/src/control_socket_request_status_tests.rs:187` `owned_surveys_queue_independently_and_restart_ignores_old_cleanup` (H; 10s): status change after a queued survey
- `crates/chan-server/src/control_socket_status_tests.rs:51` `request` (H; 10s): helper: control request round trip
- `crates/chan-server/src/devserver.rs:5405` `a_held_transfer_worker_cannot_hold_the_devserver_stop` (H-tight; 5s; 5s; 100ms): releasing_host stop with a test-set 100 ms release bound beside a deliberately held transfer worker (expiry deterministic); 5 s guards over the devserver host stop and the held-worker signal
- `crates/chan-server/src/devserver.rs:5517` `host_drain_leaves_a_held_files_attach` (H-tight; 5s; 5s; 5s): watch attach frame, host drain after release, watch worker exit (real watch worker)
- `crates/chan-server/src/devserver.rs:5824` `timed_out_mount_becomes_visible_failed_intent` (E; 1s): time_bound_mount(1 s) over std::future::pending: expiry is the asserted, deterministic path
- `crates/chan-server/src/devserver.rs:5870` `cancelled_client_off_persists_after_host_detachment` (H; 10s): whole-test guard over a real devserver register and off
- `crates/chan-server/src/devserver.rs:5912` `cancelled_client_off_preserves_a_newer_on_attempt` (H; 10s): same
- `crates/chan-server/src/devserver.rs:5991` `cancelled_client_mount_settles_startup_and_surfaces_failure` (H; 200ms): begin_fdstore_apply_after_restore must answer within 200 ms after a cancelled attempt (in-memory startup state); tight value, light work
- `crates/chan-server/src/devserver.rs:6050` `workspace_root_removed_during_startup_fails_closed` (H; 10s): failed mount settles after its root is removed
- `crates/chan-server/src/devserver.rs:6143` `chan_close_during_startup_stays_off_preserves_metadata_and_reopens` (H-tight; 2s; 10s; 10s): close_workspace_for_root during startup on a real devserver state must answer inside 2 s; stale mount and reopen 10 s
- `crates/chan-server/src/devserver.rs:6279` `chan_close_remove_during_startup_forgets_metadata_preserves_source_and_reopens_fresh` (H-tight; 2s; 10s; 10s): remove_workspace_for_root (registry write) during startup inside 2 s; stale mount and fresh reopen 10 s
- `crates/chan-server/src/devserver.rs:7553` `terminal_close_reason_from_drain_is_shutdown` (H; 30s; 30s): terminal ready and closed frames
- `crates/chan-server/src/devserver.rs:8414` `a_timed_out_attempt_leaves_a_tenant_that_arrived_while_it_waited` (H; 10s): launcher build parks
- `crates/chan-server/src/devserver.rs:9128` `startup_restore_restores_other_roots_while_one_hangs` (M; 5s mount_timeout): restore's shared deadline (restore.started + mount_timeout): the healthy root's real mount must finish inside 5 s beside a hung root or it expires and is_root_mounted(other) fails
- `crates/chan-server/src/devserver.rs:9730` `feed_next` (H; 30s): helper: feed frame
- `crates/chan-server/src/devserver.rs:10215` `restore_note_probe` (H; 15s): child test process
- `crates/chan-server/src/devserver.rs:10947` `a_restore_that_ends_at_a_stop_leaves_the_fdstore_apply_unclaimed` (H; 5s): begin_fdstore_apply_after_restore claim after a stopped restore (in-memory); asserts Ok(false)
- `crates/chan-server/src/devserver.rs:12082` `lifecycle_beside_abandoned_root_call` (H; 30s; 10ms step; 100ms; 8s): 100 ms expect_err on a caller held at its filesystem hop (E); 30 s poll; 8 s close or remove (shutdown budget 500 ms on a held hop)
- `crates/chan-server/src/devserver.rs:12526` `abandoned_root_check_holds_mount_admission` (H; 30s; 100ms; 100ms): 100 ms expect_err on callers held behind an abandoned root check (E); 30 s poll
- `crates/chan-server/src/devserver.rs:13636` `an_off_without_a_devserver_record_persists_after_a_held_teardown` (H; 8s): off over the router answers 503 at the test-set 200 ms shutdown budget (held); 8 s guard
- `crates/chan-server/src/devserver.rs:13677` `held_close_for_devserver_clear` (M; 3s; 1ms step; shutdown budget 5s (line 13667)): helper sets the shutdown release budget to 5 s and returns a close held in Closing; each caller's product calls and Closing assertions must land before that 5 s ends; the 3 s poll is H
- `crates/chan-server/src/devserver.rs:13734` `a_devserver_off_leaves_another_closes_mark_during_teardown` (M; 5s; held close budget 5s): caller of held_close_for_devserver_clear: the devserver off (record and overlay save) must run before the held close's 5 s budget ends, then asserts Closing; the 5 s close wait after release is H-tight
- `crates/chan-server/src/devserver.rs:13789` `a_stale_attempt_leaves_another_closes_mark_during_teardown` (M; 5s; held close budget 5s): same helper: a stale attempt over an off record, then asserts Closing
- `crates/chan-server/src/devserver.rs:13839` `an_off_settlement_leaves_another_closes_mark_during_teardown` (M; 5s; held close budget 5s): same helper: an off settlement, then asserts Closing
- `crates/chan-server/src/devserver.rs:13890` `a_devserver_off_whose_teardown_is_still_held_answers_still_releasing` (H; 8s; 10ms step): off answers 503 at the test-set 200 ms shutdown budget (held); HEALTHY_ROOT_BOUND poll after release
- `crates/chan-server/src/devserver.rs:14022` `a_devserver_forget_whose_teardown_is_still_held_answers_still_releasing` (H; 8s; 10ms step): forget answers 503 at its bound (held); poll after release
- `crates/chan-server/src/devserver.rs:14469` `a_starting_record_whose_forget_must_retry_is_left_off` (H; 10s): poll until a removal is admitted
- `crates/chan-server/src/devserver.rs:14575` `an_attempt_that_read_a_refused_forgets_tombstone_leaves_the_record_off` (H; 10s; 10s): poll the record intent; registration after release
- `crates/chan-server/src/devserver.rs:14628` `a_refused_forget_leaves_a_later_turn_on_alone` (H; 10s; 10s): same
- `crates/chan-server/src/devserver.rs:14846` `a_refused_forget_leaves_a_failed_records_later_turn_on_alone` (H; 10s; 1ms step; 10s): same, polling for Removing
- `crates/chan-server/src/devserver.rs:14893` `a_refused_forget_leaves_a_later_forgets_tombstone_alone` (H; 10s; 10s): same
- `crates/chan-server/src/devserver.rs:15238` `a_serve_beside_an_abandoned_root_check_answers_already_open_inside_its_bound` (H; 30s; 10ms step; 10s; 10s; 10s): poll; serve, close and forget beside an abandoned root check (production release budget, held)
- `crates/chan-server/src/devserver.rs:15318` `registrations_of_a_hung_root_hold_one_blocking_thread` (M; 500ms mount_timeout): the hung root's first registration must reach the held register step inside 500 ms or it expires on the way, the stall is never entered and the fixture wait fails; hung_root_hop_holds_one_blocking_thread's comment names this risk for its own caller
- `crates/chan-server/src/devserver.rs:15384` `a_registration_beside_an_expired_restore_holds_no_second_thread` (M CONTROL; 500ms mount_timeout): restore's shared deadline: the other row's registration must finish inside 500 ms or it is skipped and kept == [other] fails
- `crates/chan-server/src/devserver.rs:15460` `restore_keeps_every_spelling_of_a_root_whose_registration_outlasts_the_budget` (H; HEALTHY_ROOT_BOUND 30s; 5ms step): poll until the restore's registration reaches the stall; also a 250 ms negative sleep (E)
- `crates/chan-server/src/devserver.rs:15572` `hung_root_hop_holds_one_blocking_thread` (H; 30s; 10ms step; 500ms; 10s): 500 ms expect_err on callers held at the hop (E); mounted-root retry 10 s guard
- `crates/chan-server/src/devserver.rs:15958` `a_serve_request_for_a_hung_root_answers_at_its_bound` (E; 500ms mount_timeout): expiry on a fully stalled root is the asserted path; load cannot flip it
- `crates/chan-server/src/devserver.rs:16197` `a_registration_during_shutdown_is_refused_and_none_is_left_running` (H; 10s; 10s; 10s; 30s; 30s): registration reaches its handler, shutdown starts, late registration, first registration, shutdown
- `crates/chan-server/src/devserver.rs:16272` `a_mount_that_outlives_the_shutdown_sweeps_publishes_nothing` (H; 10s): stall.wait_entered for a mount reaching its root
- `crates/chan-server/src/devserver.rs:16328` `a_mount_built_before_the_last_sweep_publishes_nothing` (H; 10s): same
- `crates/chan-server/src/devserver.rs:16397` `a_mount_settling_after_the_shutdown_sweeps_keeps_the_overlay` (H; 10s): same
- `crates/chan-server/src/devserver.rs:16504` `signal_stop` (H; 10s): helper signal_stop: lifetime tasks finish after the stop signal
- `crates/chan-server/src/devserver.rs:16837` `a_mount_admitted_before_stop_keeps_its_registration` (H; 10s): mount finishes after its registration resumes
- `crates/chan-server/src/devserver.rs:18702` `a_relinked_roots_pending_and_failed_on_read_on_its_row` (H; 10s): poll for a Starting record
- `crates/chan-server/src/devserver.rs:19835` `stranded_mount_build_recovers_once_the_handle_is_released` (M CONTROL; 3s; 1s): execute_mount_attempt with a 1 s bound while the test waits 3 s for the build's entered signal: a build that has not entered before the 1 s bound ends never takes the release receiver
- `crates/chan-server/src/devserver.rs:21020` `an_own_forget_readds_without_old_record_or_saved_row` (H; 30s): re-add after its own forget
- `crates/chan-server/src/devserver.rs:22339` `watch_waiter_must_be_armed_before_the_change` (E; 200ms; 50ms): notify already fired (deterministic) and a 50 ms negative wait
- `crates/chan-server/src/devserver.rs:22390` `the_registry_reload_watcher_reloads_and_signals_on_an_edit` (H; 10s): registry watcher signals after an external edit
- `crates/chan-server/src/devserver_handoff.rs:954` `request_deadline_case` (H; 15s; 1s; 10ms): 15 s whole-case guard; paused clock advanced 1 s then a 10 ms poll (E)
- `crates/chan-server/src/devserver_handoff.rs:1008` `request_handler_case` (H; 15s): whole-case guard
- `crates/chan-server/src/devserver_handoff.rs:1077` `registration_request_without_a_trailing_newline_is_refused` (H; 15s): whole-test guard (start_paused)
- `crates/chan-server/src/devserver_handoff.rs:1125` `registration_request_over_the_byte_cap_is_refused` (H; 15s): whole-test guard (start_paused)
- `crates/chan-server/src/devserver_handoff.rs:1188` `registration_with_delayed_reply` (M; client budget 2s vs 300ms; 5s; 3s; 1s): registration_waits_for_a_delayed_mount_reply passes a 2 s client budget against a 300 ms stub delay: if accept plus delay outlast 2 s the client answers ReplyTimedOut and the Registered assertion fails; the raced work is the stub and socket I/O; low
- `crates/chan-server/src/devserver_handoff.rs:1265` `registration_after_request` (H; 5s): helper over an in-memory duplex stub
- `crates/chan-server/src/devserver_handoff.rs:1338` `registration_read_error_after_request_is_not_no_devserver` (H; 5s; product budget 5s): exchange over a reset reader (immediate error)
- `crates/chan-server/src/devserver_handoff.rs:1353` `registration_drop_before_request_is_no_devserver` (H; 5s; product budget 5s): exchange over a dropped peer (immediate)
- `crates/chan-server/src/devserver_handoff.rs:1580` `an_over_cap_registration_reports_the_refusal_its_failed_write_left` (H; 10s): over-cap registration
- `crates/chan-server/src/devserver_handoff.rs:1626` `listener_stop_waits_for_an_in_flight_reply` (H; 10s; 10s): request reaches its handler; stop after the last reply
- `crates/chan-server/src/devserver_handoff.rs:1686` `listener_stop_aborts_a_connection_past_the_drain_bound` (H; 300s): stop past the drain bound; elapsed >= REGISTER_REPLY_TIMEOUT
- `crates/chan-server/src/devserver_handoff.rs:1763` `listener_round_trip_registered_pipe` (H; 5s; 1s; 5s; 1s): named-pipe round trips and handler reports (Windows)
- `crates/chan-server/src/devserver_handoff.rs:1892` `different_user_is_refused_before_dispatch` (H; 1s): refusal closes the connection
- `crates/chan-server/src/extensions.rs:923` `start_in_child_process` (H; 60s): child process
- `crates/chan-server/src/extensions.rs:1231` `runtime_starts_and_reaps_a_declared_process` (H-tight; 1s): declared extension process reaped after runtime.shutdown (spawned process)
- `crates/chan-server/src/extensions.rs:1265` `invalid_handshake_reaps_the_declared_process_group` (H-tight; 1s): descendant process reaped after an invalid handshake (spawned process)
- `crates/chan-server/src/extract.rs:702` `a_rejection_logs_what_the_framework_said` (H; 60s): child process
- `crates/chan-server/src/handoff.rs:1222` `try_handoff` (P; 3000ms): try_handoff read window
- `crates/chan-server/src/handoff.rs:1335` `try_close_workspace` (P; 3000ms): try_close_workspace read window
- `crates/chan-server/src/handoff.rs:1464` `try_open_devserver` (P; 3000ms): try_open_devserver read window
- `crates/chan-server/src/handoff.rs:1709` `try_upgrade_at` (P; 15s): try_upgrade_at read window
- `crates/chan-server/src/handoff.rs:1767` `request_deadline_case` (H; 15s; 1s; 10ms): 15 s whole-case guard; paused clock advanced 1 s then a 10 ms poll (E)
- `crates/chan-server/src/handoff.rs:1820` `request_handler_case` (H; 15s): whole-case guard
- `crates/chan-server/src/handoff.rs:1887` `handoff_request_without_a_trailing_newline_is_refused` (H; 15s): whole-test guard (start_paused)
- `crates/chan-server/src/handoff.rs:1933` `handoff_request_over_the_byte_cap_is_refused` (H; 15s): whole-test guard (start_paused)
- `crates/chan-server/src/handoff.rs:2035` `assert_client_socket_gate` (M; 100ms accept window): the stub server accepts for 100 ms only: on the owned socket the product client's socket checks and connect must land inside it, else the stub returns None and the client ends NoDesktop after its 3 s read window, failing observed == [(false,false),(true,true)]; on the link the 100 ms is a negative wait
- `crates/chan-server/src/handoff.rs:2602` `desktop_liveness_probe_bounds_missing_and_stale_sockets` (H; 1s; 1s): liveness probes of a missing and a stale socket
- `crates/chan-server/src/handoff.rs:2754` `listener_refuses_a_different_uid_before_dispatch` (H; 1s; 1s): uid resolver runs; the refused connection closes
- `crates/chan-server/src/handoff.rs:2799` `an_over_cap_request_reports_the_refusal_its_failed_write_left` (H; 10s): over-cap request
- `crates/chan-server/src/handoff.rs:2847` `listener_stop_waits_for_an_in_flight_reply` (H; 10s; 10s): request reaches its handler; stop after the last reply
- `crates/chan-server/src/handoff.rs:2907` `listener_stop_aborts_a_connection_past_the_drain_bound` (H; 300s): drain bound; elapsed >= CONNECTION_DRAIN_TIMEOUT
- `crates/chan-server/src/lib.rs:2166` `the_stops_reindex_cancel_beside_a_held_cell_keeps_no_worker_and_cancels_once_let_go` (H; 10ms; 1s; 10s): 1 s wait for the test's own 10 ms timer (progress probe, E); 10 s guard on the stop task
- `crates/chan-server/src/lib.rs:2304` `the_hosts_calls_into_a_tenant_whose_cell_a_reset_holds_keep_no_worker` (H-tight; 10s; 10ms; 1s; 1s; 30s): host calls incl. open_or_get_registered_workspace of a mounted root (real host) must return inside 1 s beside a held cell; 1 s progress probe on the test's own timer (E); 30 s reset
- `crates/chan-server/src/lib.rs:2468` `control_round_trip` (H; 10s): helper: control round trip
- `crates/chan-server/src/lib.rs:2499` `tenant_builders_preserve_routes_and_state` (H; 60s): child process
- `crates/chan-server/src/mcp_bridge.rs:485` `bridge_call_during_workspace_swap` (M CONTROL; 15s): whole-case 15 s guard over build_app, export and a reset or import route whose drain runs under the cfg(test) 500 ms RESET/IMPORT_DRAIN_DEADLINE; asserts status OK and the flushed content
- `crates/chan-server/src/mcp_bridge.rs:607` `mcp_idle_initialized_session_does_not_pin_the_workspace_cell` (H-tight; 5s; 1s): 5 s whole-test guard over a library and workspace open plus an MCP session; 1 s for the workspace lock to free
- `crates/chan-server/src/mcp_bridge.rs:646` `mcp_unmount_releases_a_silent_clients_workspace` (H-tight; 4s; 1s): 4 s whole-test guard; 1 s for the lock to free after unmount
- `crates/chan-server/src/mcp_bridge.rs:683` `mcp_unmount_stops_a_running_tool_body_inside_its_walk` (H-tight; 5s; 1s; 1s): 5 s whole-test guard; 1 s each for the cancel token and the lock release
- `crates/chan-server/src/mcp_bridge.rs:805` `mcp_unmount_closes_hosted_sessions_before_waiting_for_the_flock` (H-tight; 15s; 4s): close_workspace_for_root bounded at 4 s, below the product's 5 s release fallback, to tell the two paths apart by time; 15 s whole-case guard
- `crates/chan-server/src/mcp_bridge.rs:955` `proxy_primary_requires_an_owned_socket_node` (E; 25ms): negative accept: no connection
- `crates/chan-server/src/route_authority.rs:748` `assert_callers_meet_table` (H; 30s): router oneshot per probe
- `crates/chan-server/src/route_authority.rs:830` `assert_uncounted_verbs_refused` (H; 30s): same
- `crates/chan-server/src/route_authority.rs:946` `assert_framework_refusals_enveloped` (H; 30s): same
- `crates/chan-server/src/routes/attachments.rs:339` `concurrent_attachment_uploads_keep_both_payloads` (H-tight; 5s; 5s; 5s): uploads through the router reach their pause and finish after resume
- `crates/chan-server/src/routes/attachments.rs:416` `tagged_draft_upload_does_not_alias_the_user_root` (H; 5s): draft event already sent by the completed upload route
- `crates/chan-server/src/routes/attachments.rs:545` `held_draft_upload_settles_before_discard_and_cannot_restore_the_source` (H-tight; 5s; 150ms; 5s; 5s): upload through the router reaches its pause and finishes; 150 ms negative wait on the discard (E)
- `crates/chan-server/src/routes/doc.rs:1136` `whole_exchange` (H; 30s): helper: socket frames
- `crates/chan-server/src/routes/doc.rs:1203` `hello_is_the_first_message_while_the_snapshot_is_not_built_yet` (E; 200ms): negative: no second message while the pool is held
- `crates/chan-server/src/routes/doc.rs:1309` `assert_root_refusal` (H; 30s): helper: close frame
- `crates/chan-server/src/routes/drafts.rs:1334` `draft_list_keeps_the_other_row_while_one_lifecycle_is_closing` (H-tight; 3s): draft list through the router while one lifecycle is closing
- `crates/chan-server/src/routes/drafts.rs:1535` `next_draft_event` (H; 5s): helper: next draft event
- `crates/chan-server/src/routes/files.rs:5288` `dropping_binary_download_body_releases_the_bounded_reader` (H-tight; 2s): download bridge stops and frees its bounded blocking reader after the body is dropped
- `crates/chan-server/src/routes/files.rs:5436` `a_workspace_archive_body_uses_the_configured_ceiling_after_preflight` (H-tight; 5s): per chunk of a workspace archive body
- `crates/chan-server/src/routes/files.rs:5675` `stalled_workspace_upload_returns_without_more_body_bytes` (H-tight; 3s; 25ms; 1s): 3 s whole-test and 1 s upload guards; product stall timeout 25 ms over a test-stalled body (expiry deterministic)
- `crates/chan-server/src/routes/files.rs:5748` `stalled_workspace_download_releases_its_slot_and_errors` (H-tight; 250ms; 3s): 3 s guard on a planned download; product stall 250 ms on an unpolled body (deterministic)
- `crates/chan-server/src/routes/files.rs:6030` `cancelled_length_declaring_stream_fails_rather_than_ending_clean` (H-tight; 2s): drain of a cancelled length-declaring file stream
- `crates/chan-server/src/routes/files.rs:6289` `api_read_file_download_plans_on_the_transfer_lane` (H-tight; 5s; 5s; 5s): download through the lane, its body, the pool blocker
- `crates/chan-server/src/routes/files.rs:7994` `held_tagged_put_settles_before_discard_and_cannot_write_a_reused_name` (H-tight; 5s; 150ms; 5s; 5s): PUT through the router reaches its pause and finishes; 150 ms negative on the discard (E)
- `crates/chan-server/src/routes/files.rs:8480` `a_workspace_directory_download_is_an_attachment_with_nosniff` (H-tight; 5s): tar archive body to_bytes
- `crates/chan-server/src/routes/files.rs:8900` `workspace_symlinks_download_as_links` (H-tight; 5s): tar archive body to_bytes
- `crates/chan-server/src/routes/files.rs:8962` `streamed_put_preserves_an_external_edit_during_the_body` (H-tight; 5s; 5s): streamed PUT reaches its pause and finishes
- `crates/chan-server/src/routes/files.rs:9713` `put_divert_answers_503_when_the_forced_scene_flush_fails` (H; 15s): whole-test guard
- `crates/chan-server/src/routes/graph.rs:2235` `recovery_settled` (H; 60s; 5ms step): helper: the workspace's own recovery settles
- `crates/chan-server/src/routes/library.rs:4652` `a_launcher_off_whose_teardown_is_still_held_answers_still_releasing` (H; 8s; 30s; 10ms step; 30s): launcher off answers 503 at the test-set 200 ms shutdown budget (held); 30 s polls
- `crates/chan-server/src/routes/library.rs:5748` `local_workspace_remove_confirms_on_live_terminals_then_force_removes` (H; 20s): real open of a registered workspace
- `crates/chan-server/src/routes/library.rs:6789` `set_local_color_fires_notify_and_is_readable` (H; 500ms): local colour notify, fired inside the completed request
- `crates/chan-server/src/routes/library_command_capability_tests.rs:1122` `session_leader` (H; 10s): helper: session roster frame
- `crates/chan-server/src/routes/library_command_capability_tests.rs:1368` `a_relinked_roots_workspace_mint_is_gated_on_its_leader_by_either_path` (H; 10s): session roster frame
- `crates/chan-server/src/routes/metadata.rs:160` `IMPORT_DRAIN_DEADLINE (const)` (P; 5s): IMPORT_DRAIN_DEADLINE under not(test)
- `crates/chan-server/src/routes/metadata.rs:162` `IMPORT_DRAIN_DEADLINE (const)` (M CONTROL-DEF; 500ms): IMPORT_DRAIN_DEADLINE under cfg(test): the import route's owner drain, lock wait and reopen bound in every test; definition behind CONTROL 3 (import arm) and CONTROL 5 (import arm)
- `crates/chan-server/src/routes/metadata.rs:286` `perform_metadata_import_with` (P; 25ms): drain poll step in perform_metadata_import_with
- `crates/chan-server/src/routes/mod.rs:244` `with_blocking_tasks_cancelled` (H; 5s): helper: a route answers with its blocking task cancelled
- `crates/chan-server/src/routes/scene.rs:770` `next_frame` (H; 30s): helper: next frame
- `crates/chan-server/src/routes/scene.rs:798` `error_after_sending` (H; 30s): helper: error frame
- `crates/chan-server/src/routes/scene.rs:863` `whole_exchange` (H; 30s): helper: whole exchange
- `crates/chan-server/src/routes/scene.rs:930` `hello_is_the_first_message_while_the_snapshot_is_not_built_yet` (E; 200ms): negative: no second message while the pool is held
- `crates/chan-server/src/routes/scene.rs:1030` `assert_root_refusal` (H; 30s): helper: close frame
- `crates/chan-server/src/routes/sessions.rs:664` `cancelled_request_announces` (H-tight; 5s; 5s): session write through the router reaches its held arm; announcement after cancellation
- `crates/chan-server/src/routes/standalone_fs.rs:2048` `stalled_standalone_upload_returns_without_more_body_bytes` (H-tight; 3s; 1s): 3 s whole-test and 1 s upload guards over a stalled standalone upload (product stall bound over a test-stalled body)
- `crates/chan-server/src/routes/storage.rs:74` `RESET_DRAIN_DEADLINE (const)` (P; 5s): RESET_DRAIN_DEADLINE under not(test)
- `crates/chan-server/src/routes/storage.rs:76` `RESET_DRAIN_DEADLINE (const)` (M CONTROL-DEF; 500ms): RESET_DRAIN_DEADLINE under cfg(test): the reset route's bound; definition behind CONTROL 2, CONTROL 3 (reset arm) and CONTROL 5 (reset arm)
- `crates/chan-server/src/routes/storage.rs:251` `perform_reset_with` (P; 25ms): drain poll step in perform_reset_with
- `crates/chan-server/src/routes/storage.rs:525` `check_busy_sessions_then_success` (H; 15s): busy arm expected (the test keeps a clone, so the 500 ms drain expiry is deterministic); the success arm retries 10 times
- `crates/chan-server/src/routes/storage.rs:737` `check_a_busy_first_wait_flushes_at_a_stop` (H; 15s): busy-at-a-stop arm expects CONFLICT
- `crates/chan-server/src/routes/terminal.rs:3395` `collect_until_idle` (E; 100ms): drain-until-quiet window; every caller discards its output
- `crates/chan-server/src/routes/transfer.rs:1631` `stalled_terminal_upload_returns_without_more_body_bytes` (H-tight; 3s; 25ms; 1s): stalled terminal upload (product stall 25 ms over a test-stalled body)
- `crates/chan-server/src/routes/transfer.rs:2170` `a_terminal_archive_body_uses_the_configured_ceiling_after_preflight` (H-tight; 5s): per chunk of a terminal archive body
- `crates/chan-server/src/routes/transfer.rs:2335` `stalled_terminal_download_releases_its_slot_and_errors` (H-tight; 250ms; 3s): stalled terminal download, product stall 250 ms on an unpolled body
- `crates/chan-server/src/routes/transfer.rs:2461` `check_symlink_archive` (H-tight; 5s): helper: per chunk of a symlink archive
- `crates/chan-server/src/routes/transfer.rs:2580` `a_terminal_directory_download_streams_a_valid_tar_on_the_fly` (H-tight; 5s): terminal directory tar body
- `crates/chan-server/src/routes/tunnel.rs:398` `websocket_pair` (H; 2s): helper: WebSocket upgrade over a local axum server
- `crates/chan-server/src/routes/tunnel.rs:545` `an_unreadable_peer_cannot_hold_a_half_close_close_forever` (H; HALF_CLOSE_CLOSE_TIMEOUT + 1s): product timer over a pending future against the same timer plus 1 s
- `crates/chan-server/src/routes/tunnel.rs:577` `an_unreadable_peer_cannot_hold_a_half_close_adapter_forever` (H; 3s): adapter ends after an inbound failure
- `crates/chan-server/src/routes/tunnel.rs:606` `a_closed_half_close_socket_ends_its_connection_task_after_a_peer_marker` (H; 2s; 3s): read through a peer marker; the connection task ends
- `crates/chan-server/src/signal.rs:184` `graceful_wait_returns_when_signalled` (H; 50ms; 5s): 50 ms settle sleep before signalling; 5 s guard on graceful_wait
- `crates/chan-server/src/signal.rs:208` `graceful_serve_returns_promptly_when_signalled` (H; 50ms; 5s): same over graceful_serve
- `crates/chan-server/src/signal.rs:272` `graceful_serve_force_exits_after_grace_deadline` (H; 3s): serve force-exits at a test-set 100 ms grace over a deliberately hung handler (deterministic); 3 s guard
- `crates/chan-server/src/standalone_watch.rs:581` `healthy_drop_releases_worker_state` (H-tight; 5s): watch attach frame (real filesystem watcher worker)
- `crates/chan-server/src/state.rs:366` `pin_blocking_pool` (H; 5s; 5s; 5s; 5s): HELD_FOR negative wait: the handler must not complete with the pool held (E); 5 s guards on releases
- `crates/chan-server/src/state.rs:658` `reset_contention_does_not_starve_single_worker_runtime` (H; 100ms; 100ms): 100 ms on try_workspace (trivial, must read Busy) and on the test's own 10 ms timer (E); the fixture writer self-releases at 500 ms
- `crates/chan-server/src/stream_bridge.rs:164` `assert_unread_stream_frees_its_pool_thread` (H; 200ms; 10s; 2s; 2s; 2s): 200 ms negative: pool must be one thread (E); 10 s; 2 s for the product stall bound to free the thread and for the body drain
- `crates/chan-server/src/window_bus.rs:387` `a_bound_during_commit_does_not_delay_a_pane_reply` (H; 2s): pane reply on a blocking thread during a commit; light

Found beside the rule's lines and read (the rule's misses):

- crates/chan-server/src/routes/storage.rs:1349 `a_reset_beside_a_drop_that_outlasts_its_wait_for_the_lock_answers_busy_with_a_cell` (CONTROL 2) and its import sibling storage.rs:1360: the bound comes through `drain_bound()` (storage.rs:1131), the timed slow drop `LetsGoIntoADropOf(drain_bound(import) * 3 / 2)` (storage.rs:1322) and the owner's let-go at `drain_bound(import) * 3 / 5` (storage.rs:1232); no Duration literal sits within 3 lines of a term.
- crates/chan-server/src/routes/storage.rs:1275 `a_reset_beside_a_reference_let_go_after_its_drop_completes` and storage.rs:1286 `an_import_beside_a_reference_let_go_after_its_drop_completes` (CONTROL 3): `LATE_REFERENCE_HOLD = Duration::from_millis(150)` (storage.rs:1059, slept at storage.rs:1215) is not within 3 lines of a listed term.
- crates/chan-server/src/routes/storage.rs:1327 and storage.rs:1338 (`LateOwner::DropHeldUntilLockWait`) and storage.rs:1297 and storage.rs:1308 (`LateOwner::OutlastsTheRoute`, deterministic busy) share the `answer_beside_a_late_reference` fixture under the same 500 ms bounds; not read further.
- crates/chan-server/src/routes/metadata.rs:1021 and storage.rs:1434 pass the cfg(test) deadline to a call; metadata.rs:1141 and storage.rs:1547 assert `took >= *_DRAIN_DEADLINE`; not read further.
- crates/chan-server/src/devserver.rs:10493 `each_row_has_its_own_outcome_whichever_settles_first`: `prepared_restore(.., Duration::from_secs(5))` sets `mount_timeout` through the helper at devserver.rs:10283-10291 (term more than 3 lines away); the two healthy rows must mount inside the 5 s restore bound beside a hung row: M.
- crates/chan-server/src/devserver.rs:10741 `ready_wait_beside_held_rows` (READY_BOUND = 2 s at devserver.rs:10723) via `prepared_restore`: a 1 s LATE hold must keep the restore alive past READY's wait, and `assert_ready_at_one_bound` asserts ReadyWait::AtBound with elapsed < READY_BOUND + 1.5 s: M (1 s to 1.5 s margins on the real clock).
- crates/chan-library/src/host.rs `open_release_budget` (18 test assignments, for example host.rs:7385 8 s, host.rs:9659 40 ms, host.rs:10958 10 s, host.rs:11357 10 s) is a product budget outside the term list; 40 ms and 200 ms values sit on test-held hops (deterministic); the 10 s values are the M (low) rows host.rs:10948 and host.rs:11384.
- `test_set_shutdown_release_budget` (13 test calls, host.rs:11712 to routes/library.rs:4635) is another; the 5 s calls at host.rs:12678 (relinked_fixture) and devserver.rs:13667 (held_close_for_devserver_clear) are the M rows host.rs:12732, host.rs:12786 and devserver.rs:13677 to 13839; the 40 ms to 500 ms calls sit on held teardowns.
- crates/chan-library/src/host.rs:12566 `BOUND = Duration::from_millis(2500)` is used as `tokio::time::timeout(BOUND, ..)` on 15 non-hit lines (host.rs:12743 to 13686): H on closes and offs that answer at the module's 40 ms budget, and inside the 5 s relinked budget at host.rs:12743.
- `with_stall_timeout(..)` (22 lines): the product stall bounds on hit lines sit on test-stalled or unpolled bodies (E parts of the H-tight transfer rows).
- crates/chan-server/src/extensions.rs:1172 `timeout(Duration::from_secs(5), ..)` through `use tokio::time::timeout` (extensions.rs:24) is missed by the literal term: H-tight (5 s for the supervisor to see a spawned extension process exit).
- crates/chan-server/src/refusal_check.rs:976 and crates/chan-server/src/routes/extensions.rs:1493 are `.timeout(Duration::from_secs(..))` request-builder calls, not tokio timeouts; not read.

The second pass, over every reader of the two route bounds, of `mount_timeout` and of an attempt bound passed to `execute_mount_attempt`, at `fd1f8a881` (`arm/d7_search.py`, its output `arm/d7-search.txt`, rc 0):

- `RESET_DRAIN_DEADLINE` and `IMPORT_DRAIN_DEADLINE` (20 lines): the two definitions each (`routes/storage.rs` 74 and 76, `routes/metadata.rs` 160 and 162); the routes' three waits and the reopen (`storage.rs` 249, 271, 284; `metadata.rs` 284, 296, 306); the doc comment in `lib.rs` 1795 and 1796; `drain_bound` (`storage.rs` 1133 and 1135, gone with the event); the reopen-bound fixtures that hand the bound to `LetsGo` (`storage.rs` 1434, `metadata.rs` 1021) and assert `took >= *_DRAIN_DEADLINE` (`storage.rs` 1547 and 1549, `metadata.rs` 1141 and 1143), which wait one bound and assert at least that bound, an expiry by construction (E).
- `mount_timeout` (11 lines): the field (`devserver.rs` 1201) and its product value `WORKSPACE_MOUNT_TIMEOUT` (3311, 8383, 8608, 19818); 9128's 5 s (recorded above); `prepared_restore`'s parameter (10286, 10291), the M rows 10493 and 10741 of the list; 15318 and 15384, the two restore tests repaired here; and `a_serve_request_for_a_hung_root_answers_at_its_bound` (15958, 500 ms), whose root is stalled at every step, so the request can only expire at its bound (E).
- An attempt bound passed to `execute_mount_attempt` (39 calls): 29 pass `WORKSPACE_MOUNT_TIMEOUT` and 3 the caller's bound (`devserver.rs` 1414, 1519, 3023); 8301 (50 ms) and 8431 (200 ms) run with the runtime's only blocking thread parked, so the attempt cannot pass its key hop and expires by construction (E); 8535 passes zero and asserts the expiry (E); 9076 (200 ms) is an attempt on a root stalled at every step (E); 19836 is the stranded test repaired here; and two are margins with no row in the list: `a_registration_removed_before_its_restores_bound_expires_is_not_restored_again` (9452, 3 s: the attempt must outlast its path to the held open and the library removal, "fixture: the attempt's bound expired before the removal landed") and `an_attempt_expiring_after_the_launcher_mounts_its_root_leaves_that_tenant` (11892, 3 s: the attempt must resolve its root inside its bound, "fixture: the attempt never resolved its root inside its bound").

The shapes the rule does not reach, counted uncut over the two crates at `fd1f8a881` (`arm/d7-search.txt`): counted poll loops, a `for _ in 0..N` with a sleep within six lines after it, 9 (the stranded test's release poll, `devserver.rs` 19854, found among them as the positive control); `recv_timeout(` calls, 169; `select!` blocks with a sleep arm within twelve lines, 15; `Duration` constants in test code, defined away from their use, 42. These are the search's stated limit: a fixture of this item's shape written in one of them is not found by the rule.

Raised for the lead's row and not repaired here, as ruled: the ten margins of the list beyond the five, 9128 (recorded) and 15318 (repaired here) (`chan-library` `host.rs` 10948 and 11384, 12732 and 12786; `devserver.rs` 13677 with its three callers 13734, 13789 and 13839; `devserver_handoff.rs` 1188; `handoff.rs` 2035), the two restore-bound margins (`devserver.rs` 10493 and 10741), the two attempt-bound margins above (9452 and 11892), and the 40 H-tight hang guards as a note.

### Acceptance

1. Red first under the cap (window 1, at the frozen bounds):
   - The reset test 3 of 20; its import sibling 4 of 20.
   - The import pair: the reset half 1 of 20; the import half green 20 of 20, sized from its measured margin with its runs the reading.
   - The restore test 4 of 20.
   - The stranded test green 20 of 20, sized from its measured margin.
   - The MCP pair 10 and 15 of 20.

   With the repair:
   - The reset test and its sibling green twenty of twenty on the event (window 2; residue 95 to 303 ms).
   - The stranded test and the MCP pair green twenty of twenty at their sized margins (window 2; the MCP retry used once).
   - The import pair and the restore test measured at the frozen 500 ms first (window 1), then under a held heavy load (windows 4 to 6) and green twenty of twenty at the final sizes (window 6).
2. One mutant each, red at its own assertion and restored (the mutants above): the restore keeping the hung root's row; the reset never answering busy with a cell under an unbounded lock wait (the route mutant that can answer success, stopped at the fixture's guard); the import answering busy beside a reference let go inside its bound; the stranded row not recovering once the handle is released; the bridge answering a call before the replacement's flush. 15318's own guard is red under its own mutant too.
3. The lead's: the whole `chan-server` lib suite at four threads in the integration guest at the landed tip, and `ci-linux` at the next `ci.yml` dispatch. Not run here.
4. The uncut search's count with its positive control in part, the reading of every other fixture it finds, the second pass and the shapes it does not reach are above. Every loop's per-run result lines are on the bus under `dev/v0107-team/evidence/Hygiene107/svrtim/` (`reds-results.txt`, `artifacts-{arm,w2,w4,w5,w6}/svrtim/*/results.txt`).

What this item does not establish: that any of the five goes red on GitHub's runner; a rate past 2 s for B under a heavier IO stall than these windows saw; the restore test's earlier reds as the registry save's tail (a reading; no red run carries the stamps).
