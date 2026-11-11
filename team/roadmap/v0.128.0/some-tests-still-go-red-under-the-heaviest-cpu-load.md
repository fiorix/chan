# Some tests still go red under the heaviest CPU load

Status: raised on 2026-11-10 from the v0.127.0 time-bound tests item's run under load, whose acceptance 1 the owner counted met with these as follow-ups; accepted for v0.128.0 by the owner the same day. Built on 2026-11-11 in three stages; the three loads and the busy symlinked-TMPDIR arm close it.

## What is there now

v0.127.0 converted the tests that bounded product waits by wall-clock seconds to read events, and under CPU load alone (one core and 24 or 64 busy loops in a capped scope, one test at a time) every converted test held in all 10 loops where the old ones went red in 9 to 10 of 10. Under the heaviest load the run tried, a quarter of a core with 16 tests at once, six tests still went red at the new code as at the old, at similar or lower rates (record kept with the v0.127.0 round's raw data):

- `files::write_tests::stalled_workspace_download_releases_its_slot_and_errors` and `transfer::tests::stalled_terminal_download_releases_its_slot_and_errors` (chan-server): the fixture's fill has to finish inside the download's 250 ms stall bound, and fails at `bulk_transfer.rs:909`.
- `handoff_row::a_handoff_of_a_root_that_is_not_mounted_answers_while_it_hangs` (chan-desktop): its fixture waits a fixed 10 s for the window.
- `hung_root::closing_a_workspace_answers_while_another_root_hangs` (chan-desktop): the close answered "workspace is still releasing; retry".
- `mcp_unmount_releases_a_silent_clients_workspace` (chan-server): the body ran past its 60 s hang guard.
- `the_hosts_calls_into_a_tenant_whose_cell_a_reset_holds_keep_no_worker` (chan-server): the reset did not reach its hold within the 60 s fixture wait.

Two tests outside the converted set went red in about the same share of loops at both versions under that load: `mount_bound::a_launcher_add_beside_a_held_registration_answers_still_releasing` (9 of 10) and `stale_prewrite_read_is_recognized_as_own_echo` (6 of 10). And the v0.127.0 full gate's symlinked-TMPDIR arm red once on `host::tests::a_replaced_root_clears_only_when_the_original_directory_returns` (chan-library, `left: Running, right: Unavailable`) on a busy host, a test that passed 7 of 7 run alone.

## Desired contract

1. Each of these tests reads an event, or bounds its wait by a pace measured in the same run, as the v0.127.0 conversions do, while still going red on the regression it guards.
2. Where a test reds because the product itself misses a budget under load (the close that answers still releasing), the item says whether the product's budget or the test's expectation is wrong under load, and fixes that one.
3. No fixture keeps a fixed wall-clock wait that a loaded host can outlast.

## Boundaries

- Tests and their fixtures; a product budget changes only if contract 2 finds it wrong.

## Acceptance

1. The same three loads as the v0.127.0 run (one core with 24 and with 64 busy loops, one test at a time; a quarter core with 16 tests at once), 10 loops each: every test named here green at the new code, with the old code's reds recorded beside it.
2. A constructed break of each test's property reds its new assertion.
3. The full gate's symlinked-TMPDIR arm green on a busy host.

## Built, 2026-11-11

Stage 1 (merged as 3ce416625): the two stalled-download tests read the private lane's retained change feed until active and queued jobs are gone instead of racing a 33-job fill against the download's 250 ms stall; the MCP unmount test gives each probe and control pair its own hang guard; the reset-hold test selects on the hold's arrival or an early end instead of a 60 s admission deadline; the replaced-root test waits on a test-only reconciliation channel after each probe instead of assuming the probe's tick published its answer. Seven constructed breaks red; the MCP test's socket cases ran in the lead's isolated environment.

Stage 2 (merged as a64cde25c): the handoff-row fixture reads the window registry's change notification instead of a ten-second poll; the hung-root close test accepts the documented still-releasing answer and observes the host's teardown-release notification before requiring the unmount, with a held-workspace test that verifies retry, off persistence and eventual release; the launcher-add test observes the registration's first pending poll before advancing its paused clock; the two own-echo tests hold the disk echo ring's test clock at the seed entry. Five breaks red; sixty green repeats; 182 module tests. Contract 2's answer: the close that answers "still releasing; retry" at the teardown hop's five-second budget is the product's documented behaviour, so the test's expectation was wrong; the separate CLI reply budget defect it exposed became its own row (closebudget).

Stage 3 (merged as 6522fe3f9): The close test's expectation of unconditional completion was wrong when release is still held; T2 tests the documented retry and eventual release. T3 fixes the distinct client budget defect in the closebudget row, with the constants shared by the close implementation and both handoff clients.

The additional metrics failure was its post-read pending assertion: a read wakes collection before copying the cache, so a completed total is valid in the first reply. The test now checks pending before any read, drives a private test clock through scan and quiet deadlines, and observes the walker's decisions under the demand lock. It checks renewed demand, retained totals while resting, and a resumed scan without sleeps or millisecond timestamp ordering. Removing the quiet guard makes it red. The sixty-second receive bounds are failure hang guards, not timing preconditions. Production sampling and scheduling are unchanged.

The row's three load profiles (acceptance 1) are measured by the lead's subagent at 6522fe3f9 against 6b8a3357c, and the busy symlinked-TMPDIR arm (acceptance 3) is read in the next integration gate; their results close the row.
