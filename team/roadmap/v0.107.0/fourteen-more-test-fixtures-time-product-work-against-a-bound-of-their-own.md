# Fourteen more test fixtures time product work against a bound of their own

Status: built on 2026-10-16 on the seat's branch; the section Built and measured 2026-10-16 holds the evidence; it closes at the GA as shipped.

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

## Built and measured 2026-10-16

Built by the hygiene seat on its branch at `bee087344`. The design note (`dev/v0107-team/reports/design-Hygiene107-tstmrg.md` in the round's bus) was ruled by the lead and read by the review seat (`reviews/review-Review107-72-tstmrg-design.md`) before the code.

The lead's rulings of 2026-10-16, in its words:

- "The two events are within "the fixtures keep their shapes": an event in place of a sleep or an accept window keeps the test's construction and assertions and removes the margin, which is the row's first preference."
- "fixtures 1, 2, 3 to 8 and 13 are waits a green run ends on an event before the bound (the open succeeding, the abandoned open letting go, the test's own release ending the teardown, the stub's 300 ms reply), so their bounds are hang guards, not margins: each is stated as an event-ended guard at a fixed size no run approaches".
- "the release is sent unconditionally right after `wait`, before `shutdown` and `restore.join()`, since a parked late attempt does not see the stop".
- "Fixture 9's bound past 7 s comes back to the lead with the numbers, as do any route `cfg(test)` bounds past 2 s; the fixtures' own constants follow the rule."

What each fixture is now, by the list's numbering.

**Events in place of a margin:**

- **`ready_wait_beside_held_rows` (`devserver.rs`), with its two callers (10).**
  - The late row's attempt lock is held until `wait_before_ready` returns, in place of a one-second sleep. The restore therefore cannot end before READY, and the late row is still pending at READY by construction.
  - The lock is let go before the stop, since an attempt parked on it does not see the stop.
  - `MARGIN`, READY's lateness past its bound, stays a margin and is sized below.
- **`assert_client_socket_gate` (`handoff.rs`), with its six callers (14).**
  - The stub server accepts until the client's future has returned, in place of a 100 ms accept window.
  - When the client has returned, the stub asks the listening socket itself (a non-blocking accept on a clone of the listener), so a connection the reactor has not reported yet is still seen.
  - A wrong client that follows the symlink is therefore accepted and read `(true, true)` on the link path at any timing. A correct one never connects and ends the wait.

**Hang guards that the test's own event ends** (no green run nears them):

- **`already_open_mount_retries_a_transitional_lock` (1):** `open_release_budget` 20 s, under the test's 30 s guard. An answer at or past the budget fails on "the retry's release budget ended before its third attempt".
- **`a_waiting_open_uses_its_own_cancellation_and_configuration` (2):** `open_release_budget` 20 s, and the wait on the open 30 s. A `WorkspaceAlreadyOpen` answer fails on "the waiting open's release budget ended before the abandoned open let go".
- **The relinked fixture's two tests (3, 4):** the fixture's teardown budget `RELINKED_TEARDOWN_BUDGET` 60 s, and their waits on the close's own steps `HELD_STEP_GUARD` 30 s.
  - `BOUND` (2.5 s) still makes an off that waits for the teardown red.
  - The relinked test asserts the close still held after its last off too.
  - The other three users of `relinked_fixture` take the larger budget with no other change.
- **`held_close_for_devserver_clear` and its three callers (5 to 8):** `HELD_CLOSE_BUDGET` 60 s, and the waits for `Closing` and for the close after `drop(kept)` at `HEALTHY_ROOT_BOUND`.
  - Each case asserts the close still held before it reads the mark.
  - A `WorkspaceAlreadyOpen` from the close fails on "the close's teardown budget ended before the held workspace was let go".
- **`registration_waits_for_a_delayed_mount_reply` (13):** the reply budget 30 s, the client's guard the budget plus `EXCHANGE_GUARD` (30 s), and the stub's guard `EXCHANGE_GUARD`. A reply past the budget fails on "the delayed reply did not land inside its 30 s budget". The 300 ms delay stays: it is what makes the reply delayed.

**Named bounds a green run waits out or measures** (sizes and readings below):

- **`each_row_has_its_own_outcome_whichever_settles_first` (9):** `HELD_ROW_BOUND` 9250 ms.
  - The held row's expiry text is built through the product's `whole_seconds`.
  - A healthy row that runs out its bound fails on "a healthy row ran out its mount bound".
  - The test asserts the held row's record still desired on before it reads the list.
- **`assert_ready_at_one_bound` (10):** `MARGIN` 1500 ms.
- **`a_registration_removed_before_its_restores_bound_expires_is_not_restored_again` (11):** `REMOVAL_ATTEMPT_BOUND` 3 s.
- **`an_attempt_expiring_after_the_launcher_mounts_its_root_leaves_that_tenant` (12):** `REVALIDATION_ATTEMPT_BOUND` 3 s.

Each constant's comment states the slowest measured length it covers.

### The reds at the frozen bounds (cap window 1)

**The setup.**
- **The guest:** `chan-v0107-hygiene` at `cpu.max 20000 100000` (memory 8G, disk 44G), from 2026-10-16T19:27:57Z to 19:40:39Z. The cap was read back at the start and after the restore, and the window is recorded in `dev/v0107-team/environments.md`.
- **The load, held at one heavy phase:** candle-core and tantivy cleaned and rebuilt, over a completed release build of `chan-workspace` in its own target directory, compiling beside each of the three jobs.
- **The host sampler:** 0.200 cores, every period throttled, over 762 s. The unit's IO pressure some avg10 peaked at 14.66, and memory some avg10 at 6.73.
- **The tests:** the nineteen tests of the fourteen fixtures at `bee087344`, twenty runs each, by exact name, at two test threads.
- **The instrument:** guest-only and print-only, on test code alone. It stamps each fixture's start and the step that must land inside its bound.

**The result:** 380 of 380 runs green, and every run ran its one test.

| Fixture | Slowest used length | Frozen bound |
| --- | --- | --- |
| 1, the retry's deadline window | 1033 ms | 10 s |
| 2, the later open to its mount | 902 ms | 10 s |
| 3 and 4, the close's spawn to its answer | 963 ms | 5 s |
| 5 to 8, the close's spawn to its answer | 1801 ms | 5 s |
| 13, the request to its reply, the 300 ms delay in it | 398 ms | 2 s |
| 14, the real path's accept | 94 ms | 100 ms |
| 9, the slowest healthy row's mount | 2160 ms | 5 s |
| 10, READY's lateness past its bound | 74 ms (one held root), 1 ms (five) | `MARGIN` 1500 ms |
| 11, the spawn to the library removal | 218 ms | 3 s |
| 12, the spawn to the revalidation's entry | 196 ms | 3 s |

**Fixture 14** shows how thin its window was: in one run in twenty of `open_workspace` and of `liveness`, the real path was accepted at 93 to 94 ms of its 100.

**Fixture 12** never meets chan-library's 1 s open release budget. The attempt waits for the root's lock, which has no budget of chan-library's (`root_locks.lock`, `host.rs` 2420), then finds the root mounted and revalidates it. It never reaches the open whose permit wait the budget bounds. Its whole path took under 196 ms.

**Records.** The per-run results are under `dev/v0107-team/evidence/Hygiene107/tstmrg/`: `artifacts-w1/tstmrg/w1-{a,b,c}/results.txt` (the archive's sha256 is `a5770cc129cbd350f83c598e6ddd6ae7b3a0ebdc5a776b8c282b0a554541d56e`), read by `analyze.py` into `w1-analysis.txt`. `analyze.py` was run first on the loop's dry run and on constructed reds (`analyze-dryrun.txt`, `analyze-constructed.txt`).

### Fixture 9's size (cap window 2)

`each_row_has_its_own_outcome_whichever_settles_first` was the one tight bound of window 1: three times its slowest healthy mount passed the 5 s bound. It was run alone, sixty times, with its bound widened to 10 s so that no run was cut.

**The setup.**
- **The window:** the same guest, cap and held load, from 2026-10-16T19:45:31Z to 19:56:41Z, the cap read back at both ends.
- **The host sampler:** 0.200 cores, every period throttled, over 669 s, and IO pressure some avg10 at most 5.58.

**The result:** 60 of 60 green.

**The slowest healthy row per run:**
- median 1109 ms;
- slowest 3005 ms, with the next 2886, 2836 and 2381 ms;
- past window 1's slowest: 8 of 60.

**The size.** Three times 3005 ms, rounded up to a 250 ms step, is 9250 ms, past 7 s, so it went to the lead with these numbers before the code.

The expiry's text is read through the product's own `whole_seconds`, which rounds the bound up, so the bound needs no whole-second size.

**Records:** `artifacts-w2/tstmrg/w2-a/results.txt` (the archive's sha256 is `7e710a1b0cda3bd2d0f8e92c3d4c895e889288e1e7affc4aa6f1d8aaa92dda74`), read into `w2-analysis.txt`.

### The sizes and what they cost

The lead's rulings of 2026-10-16 on the sizes, in its words:

- "10's `MARGIN`, 11 and 12 stay at 1500 ms, 3 s and 3 s as named constants; each comment states the bound and the slowest measured length it covers in the present tense ... No sixty-run window for the three: a green run does not wait `MARGIN`, and the 4.5 s per suite run is not worth the margin lost."
- "fixture 9's bound is 9250 ms, the rule's size, three times the slowest measured in the window rounded up to a 250 ms step. The 7 s mark was the lead's estimate before the measurement and the rule outranks it; the cost is one held row waiting 4.25 s longer in each `chan-server` suite run, against a margin twenty runs could not have certified at 7 s (four of sixty past its third)."

| Fixture | Bound | Slowest measured | Cost in a green run |
| --- | --- | --- | --- |
| 9, `HELD_ROW_BOUND` | 9250 ms | 3005 ms in sixty runs | the held row waits it out: 4.25 s more per run than the 5 s it replaces |
| 10, `MARGIN` | 1500 ms | 74 ms in forty runs | none; READY at two bounds is still red |
| 11, `REMOVAL_ATTEMPT_BOUND` | 3 s | 218 ms in twenty runs | the held open waits it out, as before |
| 12, `REVALIDATION_ATTEMPT_BOUND` | 3 s | 196 ms in twenty runs | the held revalidation waits it out, as before |
| 1 and 2, the release budget | 20 s | 1033 ms and 902 ms | none; the test's event ends the wait |
| 3 to 8, the teardown budgets | 60 s | 1801 ms | none; the test's release ends the teardown |
| 13, the reply budget | 30 s | 398 ms | none; the stub's reply ends the wait |
| 10 and 14, the events | | | 10's late row no longer sleeps a second; 14's accept ends with the client |

### The own gate

At the item commit `6e37bd0fd` (the one-assertion repair below amended in; `94ee1b871` before it, gated the same way with the same counts), in the same guest as `ubuntu` with `RUSTFLAGS=-Dwarnings`, two cargo jobs and two test threads. The checkout was fetched and detached at the commit, clean before and after every step, and each step was bounded inside the guest. The commit as it lands differs from `6e37bd0fd` in this row, the commit message and one string, fixture 13's failure message; at the landing commit that test ran once, green, beside `cargo fmt --check` (rc 0), its log `f1.log`.

| Step | Result |
| --- | --- |
| `cargo fmt --check` | rc 0 |
| `cargo clippy --locked -p chan-library -p chan-server --all-targets -j2 -- -D warnings` | rc 0 |
| `cargo test --locked -p chan-library --all-targets -j2 -- --test-threads=2` | 708 passed, 0 failed, 1 ignored |
| `cargo test --locked -p chan-server --all-targets -j2 -- --test-threads=2` | 2272 passed, 0 failed, 1 ignored |

The ignored tests are `terminal_sessions::shell_profiles::tests::print_discovered_profiles`, which prints host state and is run by hand, and `devserver::tests::emit_restore_note_in_child`, which runs only through its parent probe.

Before the commit, the same code passed a check that applied the diff, formatted both crates, and ran fmt, clippy and the touched tests (chan-library 22, chan-server 38). Its one rustfmt rewrap is in the commit.

The logs are under `artifacts-w4/tstmrg/gate-2/`, `gate-1/` and `item-check-205801/`.

### The greens at the final sizes (cap window 3)

**The setup.**
- **The window:** the same guest, cap and held load, from 2026-10-16T20:11:52Z to 20:23:22Z, the cap read back at both ends.
- **The host sampler:** 0.200 cores, every period throttled, over 689 s. IO pressure some avg10 at most 19.3, memory some at most 0.4.
- **The load:** candle-core and tantivy compiling beside each job.
- **The tests:** the nineteen tests by exact name, twenty runs each, from the item commit's own test binaries, with no instrument.

**The result:** 380 of 380 green at `94ee1b871`, and every run ran its one test. This covers the events (10 and 14), the guards (1 to 8 and 13) and the sized bounds (9 at 9250 ms, 10's `MARGIN`, 11 and 12) as they ship.

The restore test's added assertion changes that test alone, so it was run twenty times more at `6e37bd0fd` (cap window 4, 2026-10-16T21:12:22Z to 21:15:49Z, the cap read back at both ends, 0.199 cores, every period throttled, the held load compiling): 20 of 20 green.

**Records:** `artifacts-w3/tstmrg/w3-{a,b,c}/results.txt` (the archive's sha256 is `8a12c89d115ea1a934cf992b9657f7eed67143c87e5556ded18737ce1d29e9d3`) and `artifacts-w4/tstmrg/w4-a/results.txt` (`4f25757285e4ee92d86bed0a7e3afa3cb7955781436d09c8ec065588c33d1acf`).

### The mutants (acceptance 2)

One product mutant per test. Each was applied alone at the item commit in the guest; the crate's test binary was built, the test run once by exact name, and the source restored and checked clean before the next.

The first eighteen are from `mutants-1` at `94ee1b871`; the restore test's assertion added afterwards changes that test alone. m9 is from `mutants-2` at the amended commit.

| Test | Mutant | Red at |
| --- | --- | --- |
| 1 `already_open_mount_retries_a_transitional_lock` | the retry loop's `WorkspaceLocked` arm removed (`host.rs` 2268) | "transitional lock bypassed the release budget: Err(Core(WorkspaceLocked))" |
| 2 `a_waiting_open_uses_its_own_cancellation_and_configuration` | the open's cancellation flag shared across calls | "a waiting open inherited the abandoned open's cancellation: ... workspace open cancelled" |
| 3 `a_relinked_close_keeps_both_keys_closing_during_off_by_either_path` | the close-by-root's not-found path clearing `Closing` marks too | "the close's mark under ... was cleared" |
| 4 `a_devserver_clear_preserves_both_keys_of_another_close` | `clear_canonical_root_lifecycle` clearing `Closing` | "a devserver clear erased the close's mark under ..." |
| 6 `a_devserver_off_leaves_another_closes_mark_during_teardown` | the devserver off's lifecycle clear made unconditional | "the devserver's off cleared the mark of a close that still awaits its teardown" |
| 7 `a_stale_attempt_leaves_another_closes_mark_during_teardown` | the stale attempt's lifecycle restore clearing unconditionally | "a stale attempt over a mounted record cleared another close's mark" |
| 8 `an_off_settlement_leaves_another_closes_mark_during_teardown` | the settlement's drop clearing unconditionally | "an off settlement cleared another close's mark" |
| 9 `each_row_has_its_own_outcome_whichever_settles_first` | a restore's failed attempt turning its record off (m9) | "the held row's record is not desired on: Some((Off, Stopped))" (`mutants-2`; green in `mutants-1` before the repair, below) |
| 10 `the_wait_before_ready_ends_within_one_bound_of_one_held_root` | READY waiting for the whole restore | "the wait before READY did not end on its bound beside one held root, after 6.0s" |
| 10 `the_wait_before_ready_ends_within_one_bound_of_five_held_roots` | READY waiting two bounds | "the wait before READY outlasted one mount bound beside five held roots: 4.0s" |
| 11 `a_registration_removed_before_its_restores_bound_expires_is_not_restored_again` | a failed attempt's overlay forget removed | "a restore whose bound expired over a removed registration left its overlay row ..." |
| 12 `an_attempt_expiring_after_the_launcher_mounts_its_root_leaves_that_tenant` | the expiry closing the tenant at its root | "the expired attempt closed a tenant it did not open" |
| 13 `registration_waits_for_a_delayed_mount_reply` | the reply bounded by 100 ms in place of the budget | the `Outcome::Registered` assertion |
| 14 the six `*_client_requires_an_owned_socket` | the owner check following the symlink (`metadata` for `symlink_metadata`) | the `observed` assertion, in all six |

**The survivor, closed.** In `mutants-1`, m9 (a restore's failed attempt calling `record.turn_off()` in `finish_failed_attempt`) left the restore test green: the test read its claim that every row is still desired on at its generation only through the saved overlay, which a restore's failed attempt does not save, so a record turned off in memory, which any later save would write off, went unseen. Two arms read it: `m9b`, the same turn-off saved, is red at the overlay assertion; and asserting the list's `entry.on` for the held row is red with no mutant, since an expired row lists `on: false` while its overlay row stays desired on, so it is no reading of the claim. The repair, ruled by the lead on 2026-10-16: the test asserts the held row's record still desired on (`record_intent` giving `DesiredMount::On`) before it reads the list, green on the product and red under m9, with m9b kept as the disk half's mutant.

**19 of 19 tests are red under their mutants.** The logs are `mutants-1.log`, `mutants-2.log`, `m9-arms.log` and `m9-arms-3.log`, and the per-mutant diffs and runs are under `artifacts-w4/tstmrg/` (`mutants-1/`, `mutants-2/`, `m9-arms/`, `m9-arms-3/`).

### The search's positive control and the shapes outside it (acceptance 4)

The server timing tests item's two commands were rerun uncut over `crates/chan-server` and `crates/chan-library`, each at an exported tree of one commit. Nothing was built.

The scripts are `dev/v0107-team/evidence/Hygiene107/tstmrg/search/search.sh`, which applies the proximity rule as that item states it, and that item's `arm/d7_search.py` for the second pass and the shapes. Its outputs are `search/base/` and `search/tip/`, with `search/control-base.txt`.

At the base `bee087344` the rule finds 392 lines, and the same commands find the fourteen again:
- the ten of the list by the rule: `host.rs` 10948, 11384, 12732 and 12786; `devserver.rs` 13677, 13734, 13789 and 13839; `devserver_handoff.rs` 1188; `handoff.rs` 2035;
- the two attempt-bound fixtures by the second pass's `execute_mount_attempt` readers: `devserver.rs` 9452 and 11892, `bound=Duration::from_secs(3)`;
- the two restore-bound fixtures through the second pass's `mount_timeout` assignment in `prepared_restore` (`devserver.rs` 10291) and that helper's callers, which pass 5 s at 10493 and `READY_BOUND` at 10741.

The shapes the rule does not reach, counted uncut at the base by the second pass:

| Shape | Count | Positive control |
| --- | --- | --- |
| Counted poll loops: a `for _ in 0..N` with a sleep within six lines after it | 8 | `routes/storage.rs` 557, `check_busy_sessions_then_success`'s ten retries 50 ms apart |
| `recv_timeout(` lines | 169 | `host.rs` 11024, `released.recv_timeout(Duration::from_secs(3))` |
| `select!` blocks with a sleep arm within twelve lines | 15 | `host.rs` 7152, a removal polled against a 5 ms sleep up to a 5 s deadline |
| `Duration` constants in test code defined away from their use | 47 | `READY_BOUND` (`devserver.rs` 10723, used at 10741) |

A fixture of this row's shape written in one of these shapes is not found by the rule; that is the rule's stated limit.

At the item commit `94ee1b871` the same commands read as follows. The rule finds 381 lines.
- **Found through a line of their own:** fixtures 1 to 5 and 13 still have a hit, their 30 s hang guards or their test's own polls.
- **Found by the second pass:** 9, 11 and 12, as the readers of their named constants.
- **No longer found by the rule:** 6 to 8, 10 and 14. 10's sleep and 14's 100 ms window are gone. The bounds 6 to 8 wait under are `HELD_CLOSE_BUDGET` and `HEALTHY_ROOT_BOUND`, constants defined away from their use.

The second pass counts 54 `Duration` constants in test code defined away from their use, against 47 at the base. The item adds eight (`RETRY_BUDGET`, `RELINKED_TEARDOWN_BUDGET`, `HELD_STEP_GUARD`, `HELD_CLOSE_BUDGET`, `EXCHANGE_GUARD`, `HELD_ROW_BOUND`, `REMOVAL_ATTEMPT_BOUND`, `REVALIDATION_ATTEMPT_BOUND`) and drops `LATE`. Each of these is a named bound with its reason stated beside it, which is the shape this row asks a fixture's bound to take.

### Acceptance

1. **Each of the fourteen was measured under the cap, twenty runs, with the probe's values recorded.**
   - Window 1 (all nineteen tests): 380 of 380 green at the frozen bounds, and no fixture's step cut at its bound. So each test is sized from its measured margin, with its runs as the reading, as the server timing tests item rules. Fixture 9 was also measured sixty times at a widened bound (window 2).
   - Window 3: the nineteen are green twenty of twenty at the final sizes under the same cap and load. The restore test is green twenty of twenty again at the amended commit (window 4).
   - Two margins are events: 10's late row and 14's accept window. The bounds of 1 to 8 and 13 are hang guards a green run ends on its own event. Four bounds are named and sized: 9, 10's `MARGIN`, 11 and 12.
2. **One mutant per test is red at its own assertion and restored**, 19 of 19, after the one survivor's test gap was closed (the mutants above).
3. **The lead's acceptance, not run here:** the whole `chan-server` and `chan-library` suites at two threads in the integration guest at the landed tip, and `ci-linux` at the next `ci.yml` dispatch. Here, the own gate's whole suites are green at the item commit.
4. **The search's positive control and the shapes outside it** are above. Every loop's per-run result lines are on the bus under `dev/v0107-team/evidence/Hygiene107/tstmrg/` (`artifacts-w1`, `artifacts-w2`, `artifacts-w3`, `artifacts-w4`, each `tstmrg/<job>/results.txt`).

**What this item does not establish:**
- that any of the fourteen goes red on GitHub's runner;
- a rate under a heavier load than these windows held;
- fixture 9 past 9250 ms, its residual: a healthy mount slower than three times the slowest of sixty runs.
