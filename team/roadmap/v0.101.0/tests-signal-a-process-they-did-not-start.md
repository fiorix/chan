# Two tests of chan-library signal a process they did not start, and one of chan-server kills by command line

Status: raised for a decision on 2026-09-28 by the report of the order on parked terminals across a prefix move (`dev/v0101-team/reports/report-Services-34.md` in the development tree, "Found beside, not changed", 1), with the lead's search of the test sources (`dev/v0101-team/journals/journal-Lead.md`, the entry of 2026-09-28 17:06Z). Read again at `ada0ecc4c`, and shown by a probe of the builder's on 2026-09-28: each of the two tests, handed the pid of a `sleep` that the probe had started in place of its made-up pid, ended that `sleep` by SIGHUP (`dev/v0101-team/evidence/Services/s34-probe.log`). Older than this round: `v0.100.0` holds the kill and both tests. The repair of the three tests is built in the development tree and not landed. Recommendation, the lead's: accept for v0.101.0.

## What was seen

Closing a terminal session that was imported across a restart signals the process whose pid the import was handed. The imported session's writer thread answers the close's kill command by calling `terminate_imported_child` with that pid (`crates/chan-library/src/terminal_sessions.rs:4755-4758`; the command sent by `Session::close`, `:5226-5236`), which, since this process is not the child's parent, sends it HUP and TERM, waits up to a second for it to go, and then sends KILL (`terminate_imported_child`, `:6142-6173`; `IMPORTED_CHILD_EXIT_GRACE`, `:86`). It checks nothing of the process's identity, where the devserver's cleanup of a skipped session signals only when the manifest's boot id and the child's start time match, through a pidfd (`signal_child`, `crates/chan-server/src/devserver/fdstore.rs:929-953`).

Two tests import a session with a pid that no child of theirs holds, and close it, on Linux alone:

- `restore_adopts_into_the_activation_manifest_set` imports a session with `child_pid: Some(4242)` and ends with `registry.close_all` (`crates/chan-library/src/host.rs:10705-10785`, the pid at `:10745`, the close at `:10784`; in the Linux-only module `fdstore_host`, `:10497-10498`).
- `restore_adopts_without_a_store_call_and_unparks_on_close` imports one with `child_pid: Some(4242)` and closes it by its id (`crates/chan-library/src/terminal_sessions.rs:11597-11658`, the pid at `:11621`, the close at `:11656`; in the Linux-only module `fdstore_parking`, `:11112-11113`).

So a run of chan-library's tests on Linux sends HUP, TERM and then KILL to whatever process holds pid 4242 in the namespace the tests run in, if one does and the tests may signal it; the gate's container runs them as root ([the-gate-container-runs-as-root](the-gate-container-runs-as-root.md)). Where no process holds the pid, the signals fail and the close returns at once.

Two more sites of a made-up pid signal nothing: `fdstore_skip_cleanup_reaps_only_terminal_windows` hands `Some(4242)` and `Some(4243)` to the cleanup of skipped sessions' windows (`host.rs:10331-10398`, the pids at `:10371`, `:10378`), which reads their window ids alone (`cleanup_skipped_fdstore_sessions`, `host.rs:2245-2271`); and `a_skipped_session_loses_its_ring_file_with_its_pty` uses `Some(42)` only to name the descriptors to remove (`crates/chan-server/src/devserver/fdstore.rs:1833-1851`). The devserver's own fd-store tests import with the pid of a child they spawned (`crates/chan-server/src/devserver.rs:13010-13013`, `:13163-13165`, `:13233-13234`).

**A third test, of chan-server, kills by command line.** `seal_finalizes_the_manifest_and_detaches_the_parked_set` ends with `kill_by_cmdline_fragment("sleep 86397")` (`crates/chan-server/src/devserver.rs:13277`, the call at `:13393`), which sends KILL to every process under `/proc` whose command line holds that fragment (the helper, `:13062-13080`). The test has read its own child's pid from the manifest before that (`:13352`). Inferred, not run: two runs of the test in one pid namespace, as two gates in one container are, end each other's child.

## Desired contract

No test signals a process it did not start: a test that imports a terminal session hands it no pid, or the pid of a child the test spawned and reaps.

## What to do

A suggestion beyond the record: import with `child_pid: None` where a test does not need a pid, and where it asserts a store name built from one, build the name from the same `None`; where a test needs a live child, spawn one and hand its pid, as the devserver's tests do. The order in hand in the development tree shows the hazard once first, with a child the probe starts itself, and changes nothing if it does not show. Red first: a probe that hands one of the two tests the pid of a child the probe started sees that child end at the test's close; after the change nothing of the probe's is signalled.

## Boundaries

The two tests and their helpers in `crates/chan-library/src/host.rs` and `crates/chan-library/src/terminal_sessions.rs`, the third test's helper and its one call in `crates/chan-server/src/devserver.rs`, and any other test a sweep finds that hands an imported session a pid it did not get from its own child. Not `terminate_imported_child` or how a close ends an imported child.

## Acceptance

1. No test imports a session with a pid it did not get from a child it started, shown by a sweep of the test sources recorded with its pattern and its hits.
2. The probe above ends its own child before the change and signals nothing after it.
3. The test of chan-server ends the child whose pid it read, and no process that it finds by its command line.
