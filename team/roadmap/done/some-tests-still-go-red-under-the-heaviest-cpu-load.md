# Some tests still go red under the heaviest CPU load

Status: shipped in [v0.128.0](../../release/release-v0.128.0.md).

Record before the release: raised on 2026-11-10 from the v0.127.0 time-bound tests item's run under load, whose acceptance 1 the owner counted met with these as follow-ups; accepted for v0.128.0 by the owner the same day. Built on 2026-11-11 in three stages; the three loads and the busy symlinked-TMPDIR arm close it.

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

Measured on 2026-11-11 (acceptance 1): the three loads of the v0.127.0 record replicated in a capped guest, old 6b8a3357c against new 6522fe3f9, ten loops each, old and new as two chains at once (`dev/v0128-team/evidence/Lead128/loads-m3/summary.md`, `tables.md`). Loads 1 and 3 hold at the new tip: every named test green in ten of ten loops where the old tip red the metrics rest test once and the doc stale read twice. Load 2 (CPUQuota 25 percent, 24 busy loops, 16 test threads) holds for eight of the nine named tests the old tip turned red (the two stalled downloads, the mcp unmount, the reset test, the doc and scene stale reads, the metrics rest, the handoff row hang: 0 of 10 at new against 1 to 10 of 10 at old) and for the three tests that exist only at new; one test is still red at new, 5 of 10: `routes::library::devserver_route_tests::mount_bound::a_launcher_add_beside_a_held_registration_answers_still_releasing`, because its fixture `on_a_paused_clock` still waits `recv_timeout(HEALTHY_ROOT_BOUND)`, 30 s of real time (`devserver.rs:4835`), a fixed wall-clock wait contract 3 rules out; its sibling `a_launcher_on_whose_mounted_revalidation_hangs_answers_at_the_mount_bound` reds the same way at both tips. The fixture's wait moves to the scenario clock in a fourth stage; the row closes with it and the symlinked-TMPDIR arm of the next integration gate.

Stage 4 (merged as 10284ab83): the mount-bound fixture `on_a_paused_clock` no longer fails a scenario that outlives 30 s of real time; it fails only when a 60 s hang guard passes with neither the scenario nor a request it sent polled, counted at each poll of the scenario and of the requests it sends (the runtime's own wakes are not counted: on a paused clock its timer driver still wakes it about every 59 s with nothing to run, so a wake count never stands still through a hang). The waits for a call to be held lose their fixed deadlines (10 s for the first, 30 s spinning for the add after it): a watcher holding a weak reference to the stall races the request, and the wait fails with the request's answer when it answers before its call is held. Measured under load 2 in a capped guest (`dev/v0128-team/evidence/Lead128/loadres4/tables.md`), old f625d1824 against new 4cbdff3c3 as two chains at once, ten loops each, twice (the two named tests alone, then the whole 336-test module scope of the earlier record): `a_launcher_add_beside_a_held_registration_answers_still_releasing` and `a_launcher_on_whose_mounted_revalidation_hangs_answers_at_the_mount_bound` 0 of 10 red at new in both drives, 2 and 1 of 10 at old at its 30 s bound (`library.rs:4264`); new runs of 41 to 43 s passed, which the old bound could not have allowed. Breaks: a registration that never releases its permit reds at the first add's assertion (503 against 200); a scenario that never releases the held registration reds at the guard after 120 s with the held calls named. Acceptance 1 is met for every test named here; the row closes with the symlinked-TMPDIR arm of the next integration gate (acceptance 3).
