# The chan-server suite holds a thread plateau the macOS runner refuses

Status: accepted for v0.103.0 rc1 by the owner's ruling of 2026-10-07; the fix is being built.

## Finding

On 2026-10-07, three of six `chan-server` unit-suite runs on GitHub's `macos-26-arm64` image `20260907.0351.1` failed when the runner refused to create threads (`os error 35`). The three red job logs under `dev/v0103-team/evidence/Lead103/rc/` are `rc0-ci-macos-job-112598360762.log` (27 failed tests), `ga-ci-macos-job-112625025469.log` (178), and `ga-ci-macos-rerun-job-112638860001.log` (141). Each burst occurred within one second, 46 to 56 seconds into the suite.

Linux measurements with four test threads in `dev/v0103-team/evidence/Lead103/int-threads-02/` and `int-threads-export-01/files/` sampled live threads every 100 ms and record peaks of 1,505 at base `cd53294cf` and 1,535 at the GA commit. A separate run, `int-threads-names-02/guest.log`, sampled names every two seconds and records a peak of 1,668 at +67 seconds: 403 r2d2 reader pools held three `r2d2-worker-N` threads each, alongside 254 `chan-bulk-transfer` workers, 48 tantivy indexing threads, 16 `segment_updater` threads and 29 tokio threads. Its name list cuts off at eight names. The large pool-thread count predates this round; the macOS failures and the Linux plateau are separate observations, and the release decision records why this plateau is being reduced before tagging.

Runtime's one-test-thread census in `dev/v0103-team/evidence/Runtime103/jobs/td-find-01.log` found that one storage test's six pool threads survived until about 29.9 seconds after their pools appeared, and 2,163 of 2,583 pool threads in the suite lived 28 to 32 seconds. It found 123 bulk-transfer lanes alive at process exit, about 102 from `devserver::tests`. The graph pools' pending thirty-second r2d2 reaper jobs held their own scheduler threads after the graphs closed. Separately, `build_devserver_app` at `crates/chan-server/src/devserver.rs:3709` installed a launcher router whose state held the host (`routes/library.rs:303`); the host's root-fallback slot (`crates/chan-library/src/host.rs:616`) held that router, keeping the host, its lane and its mounted state alive. A separate fd parker ring spans `host.rs:1802` and `crates/chan-server/src/devserver/fdstore.rs:209`, `503` and `524`. Runtime's two handbacks are `dev/v0103-team/reports/handback-Runtime103-graph-reaper.md` and `handback-Runtime103-lane-root-fallback.md`.

## Owner decision, 2026-10-07

The owner chose option A of the GA tag-hold survey: hold the tag and cut v0.103.0 rc1 with a reduction of the suite's thread plateau. The decision and survey receipts are `dev/v0103-team/reports/decision-Lead103-v0.103.0-tag-hold.md` and `dev/v0103-team/evidence/Lead103/surveys/ga-tag-hold.*`. The owner then withdrew the proposed shared scheduler and chose to end pool and lane threads with their owners; no scheduler is shared between graphs.

## Fix

A workspace graph's r2d2 reader pool now sets no idle timeout or maximum lifetime, so it schedules no reaper job and its own three scheduler threads end when that graph closes. The host holds its launcher root fallback only while a router or one of its in-flight requests holds the shared lease, breaking the strong-reference cycle; when other holders release the host, its bulk-transfer lane and anything it still mounted can end. The graph's reader checkout bound, connection pool size and SQLite pragmas are unchanged. A host whose routers have all been dropped answers 404 at the root until a new fallback is installed; the devserver and desktop each install once and keep one router.

An idle graph's reader connections now retain their SQLite page cache while that graph is open, up to the bundled SQLite default of 2,000 KiB per connection, where the reaper previously gave it back by closing and reopening idle connections every ten minutes. Runtime's `b42f7fdcb` states that cost in the graph comment and design. This repair does not free a devserver's host on stop while its registry reload watcher deliberately holds it. Follow-ups remain for the launcher router's own strong host handle, that watcher, the fd parker's ring in both proposed forms, two lanes whose holder was not found, and the `extensions` test that cannot run with `RUST_TEST_THREADS=1` in its environment.

## Measurements on the fix

In Runtime's two-CPU Linux guest, the whole `chan-server` suite at four test threads peaked at 2,684 live threads on `939ecf376`, 524 after the graph pair, and 141 after the host repair with the two-second name sampler; the repaired tip peaked at 197 with a 100 ms sampler. In the one-thread exit census, lanes alive fell from 123 to 26, consisting of the test binary's shared lane, the fd parker's ring and about two lanes in `devserver::tests` whose holder was not found. No graph or index thread remained at exit, where fourteen workspaces' worth had remained before. The one storage test's six pool threads were gone at its end instead of surviving about 29.9 seconds; one devserver test's lane threads were gone at the first sample after its end, about 0.01 seconds, instead of living through the 45-second hold. These results and their samplers are in `dev/v0103-team/evidence/Runtime103/jobs/td-lane-gate-08.log` and the two handbacks above. They are Linux measurements, not the rc1 candidate's macOS result.

## Acceptance

1. Run a storage test and a devserver test alone: every thread of each test's own state is gone within one second after that test ends, apart from the test binary's shared lane.
2. On Linux with four test threads, the whole `chan-server` unit suite peaks under 600 live threads using the two-second thread-name sampler shaped like `dev/v0103-team/evidence/Lead103/rc/int-threads-names-guest.sh`.
3. Every macOS run of the suite on the v0.103.0 rc1 candidate, including CI and the release dry run's validation, is green on its first attempt. Record every run and its count; a red fails this acceptance rather than being erased by a rerun.
