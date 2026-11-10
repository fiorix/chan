# Some tests still go red under the heaviest CPU load

Status: raised on 2026-11-10 from the v0.127.0 time-bound tests item's run under load, whose acceptance 1 the owner counted met with these as follow-ups; accepted for v0.128.0 by the owner the same day. Not started.

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
