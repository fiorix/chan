# Suite tests go red under load and green in a quiet window

Status: raised for v0.105.0 by the owner's word of 2026-10-09, from the v0.104.0 release report's follow-ups; written down, not designed, not accepted for build.

## What was seen

Everything here was seen on Linux, in sdme guests on one development box, on 2026-10-08 during the v0.104.0 round. The [v0.104.0 report](../../release/release-v0.104.0.md) carries it under Follow-ups ("Investigate load-sensitive suite timeouts with their red and quiet-green records kept together, including the fold-test red under throttled web load") and in its Retrospective ("Reds were kept").

**The count.** `dev/v0104-team/reports/report-Hygiene104-item8-series.md` ("Hand-back", "Method and evidence" and its two tables) ran the whole `chan-server` suite forty times with `RUSTFLAGS=-D warnings RUST_TEST_THREADS=16 cargo test -p chan-server -- --test-threads=16` and `CARGO_BUILD_JOBS=2`, each run under a 600-second bound in a guest held at a host `cpu.max` of `200000 100000` (two CPUs) and a `memory.max` of 6,442,450,944 bytes (6 GiB): twenty runs at the base `9108113357f00c77393fd41932d1a0df2b7a09a8` and twenty at `21617ff0d945b520de60820ea99c93dc49f21210`, the tip of the two Rust test repairs of [tests-that-fail-off-the-gates-path](../done/tests-that-fail-off-the-gates-path.md). Each arm had 16 green runs and 4 test-red runs (exit 101): base runs 02, 03, 05 and 12, tip runs 08, 15, 16 and 19. The two repaired tests were green in all forty runs, and the report's "Reading and limits" says the count shows no improvement in the whole-suite green rate.

**The eight tests that failed in the count** (the report's "Failed tests in the eight test-red runs"; each located in the released tree `af2af8ac0` by a search for its function):

- `devserver::tests::startup_restore_restores_other_roots_while_one_hangs` (`crates/chan-server/src/devserver.rs` line 8555): base 02 and 05, tip 16.
- `devserver::tests::stranded_mount_build_recovers_once_the_handle_is_released` (`devserver.rs` line 19201): base 02, tip 08, 15 and 16.
- `devserver::tests::startup_restore_cap::each_row_has_its_own_outcome_whichever_settles_first` (`devserver.rs` line 9909): base 05, tip 16.
- `routes::files::write_tests::a_create_a_delete_and_a_move_note_the_window_that_asked` (`crates/chan-server/src/routes/files.rs` line 6338): base 02.
- `routes::files::write_tests::unread_workspace_text_stream_frees_its_pool_thread` (`routes/files.rs` line 5774): base 03 and 12, tip 08.
- `routes::storage::tests::a_reset_beside_a_drop_that_outlasts_its_wait_for_the_lock_answers_busy_with_a_cell` (`crates/chan-server/src/routes/storage.rs` line 1349): base 03, tip 19.
- `routes::storage::tests::a_reset_beside_a_reference_let_go_after_its_drop_completes` (`routes/storage.rs` line 1275): base 03.
- `mcp_bridge::tests::mcp_import_flush_waits_for_the_replacement_workspace` (`crates/chan-server/src/mcp_bridge.rs` line 593): tip 16.

**Memory in the count.** Base runs 1 to 17 and tip runs 1 to 11 met the 6 GiB cap and raised `memory.events max`; the later runs did not, and no run had an OOM kill ("Reading and limits"). Three of the red runs were below the cap: tip 15, 16 and 19 peaked at 3,895,914,496, 3,937,230,848 and 2,953,240,576 bytes (the tip table).

**Later sightings the same day.** Rows 2 and 8 of `dev/v0104-team/reports/held-observations-Lead104.md`, with that file's addition of 15:13:30Z, collect them; each is backed by a section of `dev/v0104-team/reports/decisions-Lead104.md`, named here by its time:

- 07:07:33Z: the MCP import flush test above, which has a 15-second whole-test bound, failed once at the base in a four-thread whole-suite run whose guest had just lost its file cache to the host's reclaim. The section of 10:23:55Z reads its failure in tip run 16 of the count as `Elapsed(())`, and the sections of 13:19:27Z and 14:56:34Z each record one more red of it in a loaded gate run.
- 11:10:57Z: `workspace::tests::serialize_all_derived_mutations_share_write_serial` (`crates/chan-workspace/src/workspace.rs` line 6142 in the released tree) ran out a ten-second bound once. The review then timed the four operations at 0.12 to 0.23 s alone (one at 1.7 s) and at most 0.87 s inside whole-suite runs at four threads; its verdict was host load "by exclusion", and the section says "not reproduced, so an attribution".
- 11:38:14Z and 14:56:34Z: `still_releasing::a_launcher_off_whose_teardown_is_still_held_answers_still_releasing` (`crates/chan-server/src/routes/library.rs` line 4442) failed on `WorkspaceAlreadyOpen` in a loaded gate, the second time as an unwrap in the symlinked-temp arm.
- 12:18:07Z: the stranded mount build test above was the one red of a committed gate whose other 2,140 server tests passed.
- 13:19:27Z: `a_removal_of_a_relinked_root_beside_a_stalled_one_answers_in_the_reply_budget` (`devserver.rs` line 16861) took 4.15 s against its 3 s budget, with the host's pressure avg10 about 2 and four guests building.
- 13:41:36Z: five server reds in one gate run, with two guests at their caps and CPU pressure about 6: four of the tests already named (the section does not say which four) and `routes::storage::tests::an_import_beside_a_drop_that_outlasts_its_wait_for_the_lock_answers_busy_with_a_cell` (`routes/storage.rs` line 1360), which answered 500 and `Missing` where it expects a busy answer.
- 14:56:34Z: `routes::storage::tests::an_import_beside_a_reference_let_go_after_its_drop_completes` (`routes/storage.rs` line 1286) answered a 409 in the symlinked-temp arm.
- 13:47:17Z, the web side: test 12 of `web/packages/workspace-app/src/editor/fold.test.ts` failed once in a throttled whole-directory run and passed alone and in both whole gates. The record names it by that number only; its name and its failing assertion are not in the records read for this item.

**The quiet greens.** The section of 14:09:01Z: under a quiet window (13:58Z to 14:08Z, every other guest idle) a whole suite at `6dcc57ad0` and a gate at `26163d9bd` both ran green, 2,142 server tests passed. The section of 15:13:30Z: a gate at `388bbe5d78fcd1c2dae177cceb40e7f66ccc9a99` ran 15:07:05Z to 15:13:00Z with the whole `chan-server` suite green under both temp directories, 2,153 passed in each arm, every other guest idle. Row 2 counts three quiet windows; the first was not opened for this item. The candidate's whole `make ci-linux` then passed (the v0.104.0 report's Validation: 5,269 Rust tests passed and six ignored), and the section of 10:05:23Z says that gate runs the suite at four threads on four CPUs, as `ci-linux` does.

**Not established.** The cause of any red: `dev/v0104-team/reports/held-observation-dispositions-Lead104.md` says "quiet green does not erase loaded red or establish a cause beyond the recorded timeouts and load". A rate: the count's report says twenty runs per arm under a shared, changing host load establish neither an underlying flake rate nor an effect of the two repairs. Whether any red is a product race and not a test's own bound: no record classifies one; the write-serial verdict is an attribution, and the section of 10:23:55Z says "one failure in twenty cannot rule out a new flake" of the import flush. Which load matters: three of the count's reds were below the memory cap, and the later sightings name CPU pressure, guests at their caps and a lost file cache without a controlled comparison. What a hosted CI runner, macOS or Windows shows for these tests is not part of this record.

## Desired contract

Each test named above either passes at a stated, recorded load (the count's command and quota, and a whole suite beside other building guests), or has a written cause that says whether the bound is the test's own or the product's and what kind of evidence shows it. A red under load is told apart from a product race by that evidence, never by a quiet rerun alone.

## What to do

Measure before repairing. Repeat the count at the v0.105.0 base under the same command, quota and bound, with the host's pressure and each run's memory peak recorded, so the rates are read beside the v0.104.0 ones. For each named test, read its bound and its wait at source and say whether it waits on time or on an event; time the awaited step alone and inside the suite at four and at sixteen threads; force the order or the delay once where a seam allows it. Identify the web test by its number from the record of the run that failed, or record that it cannot be identified. Report the classification to the lead before any change: a test's own race is repaired in the test, and a product race is reported and waits for a decision.

## Boundaries

The test modules of the named tests in `crates/chan-server/src/devserver.rs`, `routes/files.rs`, `routes/storage.rs`, `routes/library.rs` and `mcp_bridge.rs`, the one in `crates/chan-workspace/src/workspace.rs`, and `web/packages/workspace-app/src/editor/fold.test.ts`. No product change without a reported product race and a decision. A bound that is widened, or a thread count that is lowered in a gate target or in CI, is a recorded decision with its measurement and not a silent repair. No red run is removed from the record or replaced by its rerun.

## Acceptance

1. A count of at least twenty whole `chan-server` suite runs at the v0.105.0 base under the v0.104.0 count's command, quota and bound, with each red run's failing tests named beside its memory peak and the host's pressure, read beside the v0.104.0 count.
2. For each of the thirteen Rust tests named above, a written cause with the run or the source reading that shows it, or "not reproduced" with the number of attempts and the load they ran under.
3. The web test identified by name with its failing assertion, and reproduced under a throttled whole-directory run or recorded as not reproduced with the number of attempts.
4. Each repaired test is red first on its own assertion with its order or delay forced, and green after; a product race, if one is found, is reported with its reproducer and no test is changed to hide it.
5. Every red of the measurement is kept beside the green that followed it.
6. The owning guest's fmt, clippy and whole crate suite for a Rust change, and `make web-check` for a web change, are green at each commit.
