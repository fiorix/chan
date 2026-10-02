# A devserver test reads a workspace's row before the lock that row probes is released

Status: shipped in [v0.101.0](../../release/release-v0.101.0.md).

Record before the release: accepted for v0.101.0 by the owner on 2026-09-29; raised for a decision on 2026-09-28 by the independent review of the hung root's fix round (`dev/v0101-team/reviews/review-Runtime-16.md` in the development tree, the note "Older than both ranges" and its evidence section), after the test failed once in that round's loops beside another job's build (`dev/v0101-team/reports/report-Runtime-28.md`, "One failure outside my pins"); the lead's notes raise it as an item, with the review's reading as its record. Read in code at `7957bccef`; not reproduced.

## Owner ruling

Accepted on 2026-09-29 for v0.101.0. The owner accepted in one answer every recommendation the lead had put to them that day, and with that answer closed v0.101.0's intake under one rule: a raised item enters v0.101.0 only when it loses a user's data or weakens security and its fix is small and local, a test-only or infrastructure item only when it makes the release gate or a release job unreliable, and an item whose fix changes a contract or reopens excluded scope, or whose fault is a wrong state with a rare trigger, goes to v0.102.0. This item enters as a test-only item that makes the release gate unreliable: a test that can fail by timing weakens every verdict of a gate that runs it. No production code changes. When it was raised the lead's notes gave no recommendation, and ruled that until it was decided a red of this test in a gate was proven by a rerun, as the landing's recipe does for two others.

## What was seen

`cancelled_client_off_persists_after_host_detachment` turns a workspace off, drops the off's future once the host has detached the runtime, and reads the workspace's row, expecting `Stopped` (`crates/chan-server/src/devserver.rs:3898-3938`, the row read at `:3919-3921`); only after that does it wait for the workspace's lock to be released (`:3930-3933`). The workspace is released meanwhile by the teardown thread that the dropped close leaves behind, as the report reads it (`HostedWorkspaceRuntime`'s drop, `crates/chan-library/src/host.rs:669-690`), and the writer lock's release clears the holder's record before it unlocks (`WorkspaceLock`'s drop, `crates/chan-workspace/src/lock.rs:308-323`, then the guard's unlock, `:55-61`). A row's status probes the lock, and a lock held with no record to read is a holder present (`classify_lock_attempt`, `lock.rs:445-450`), which the row reads as `Locked` (`host.rs:3889-3892`). So a read that lands between the record's clear and the unlock reads `Locked`, and the test fails at `:3921` on unchanged code.

The one failure recorded read `Locked` where `Stopped` was expected, in a loop of the devserver's module while another gate compiled in the same container (`report-Runtime-28.md`). The mechanism is the review's reading and was not reproduced: 60 runs of the module on each of the base's and the tip's binaries, interleaved, and 200 runs of the test alone on one CPU on each, all passed.

**Read again at `4c4ada0a1` on 2026-09-29:** the test is at `crates/chan-server/src/devserver.rs:4184-4223`; it reads the row at `:4204-4206` and waits for the release after that, at `:4216`. Read, not run; the records of the integration branch's gates show no second failure.

## Desired contract

The test asserts what an off that its client cancelled persists, and reads nothing that the workspace's release is still changing.

## What to do

Wait for the release before the row is read, or read the row until it is `Stopped` inside the test's own timeout, and keep every assertion. Red first if a test seam can hold the release between the record's clear and its unlock; if none can without a production hook, the report says so and the fix is shown by a loop instead.

## Boundaries

The test in `crates/chan-server/src/devserver.rs`. No production change.

## Acceptance

1. The test reads the row only when the release cannot change what it reads, shown by a run that holds the release where a seam allows.
2. The test passes in a loop of its module on one CPU beside a compile, and the count is in the report.

## What shipped

The build is on the integration branch and not on `main`, in ranges the lead accepted, with the combined gate green on Linux at the integration's tip. This record was written on 2026-10-02 from a reading of the code at that tip; what the acceptance of its range found beyond the code is in the round's records and was not read for it.

A test-only change: `cancelled_client_off_persists_after_host_detachment` (`crates/chan-server/src/devserver.rs`) waits until no reference is left and the root's lock is free before it reads the row and asserts it stopped, and keeps its other assertions and its ten seconds. The test is in the tree and its ordering is read in the code; the run that holds the release and the loop the acceptance asks for were recorded in the round and are not reproduced by the tree. No changelog line, the change being a test's.
