# The chan-server suite holds a thread plateau the macOS runner refuses

Status: accepted for v0.103.0 rc1 by the owner's ruling of 2026-10-07; the fix is being built.

## Finding

On 2026-10-07, three of six `chan-server` unit-suite runs on GitHub's `macos-26-arm64` image `20260907.0351.1` failed when the runner refused to create threads (`os error 35`). The three red job logs under `dev/v0103-team/evidence/Lead103/rc/` are `rc0-ci-macos-job-112598360762.log` (27 failed tests), `ga-ci-macos-job-112625025469.log` (178), and `ga-ci-macos-rerun-job-112638860001.log` (141). Each burst occurred within one second, 46 to 56 seconds into the suite.

Linux measurements with four test threads sampled live threads every 100 ms. `dev/v0103-team/evidence/Lead103/int-threads-02/` and `int-threads-export-01/files/` record peaks of 1,505 at base `cd53294cf` and 1,535 at the GA commit. `int-threads-names-02/guest.log` records a peak of 1,668 at +67 seconds: 403 r2d2 reader pools held three `r2d2-worker-N` threads each, alongside 254 `chan-bulk-transfer` workers, 48 tantivy threads and 29 tokio threads. The large pool-thread count predates this round; the macOS failures and the Linux plateau are separate observations, and the release decision records why this plateau is being reduced before tagging.

## Owner decision, 2026-10-07

The owner chose option A of the GA tag-hold survey: hold the tag and cut v0.103.0 rc1 with a reduction of the suite's thread plateau. The decision and survey receipts are `dev/v0103-team/reports/decision-Lead103-v0.103.0-tag-hold.md` and `dev/v0103-team/evidence/Lead103/surveys/ga-tag-hold.*`.

## Fix

Every workspace graph's r2d2 reader pool shares one `ScheduledThreadPool` of three threads per process instead of building three scheduler threads for each pool. The change is in `crates/chan-workspace/src/graph.rs`; the reader checkout bound, the pool's connection size and its SQLite pragmas stay unchanged.

## Acceptance

1. On Linux with four test threads, the `chan-server` unit suite's peak live-thread count is under 600, and every sample has at most three `r2d2-worker` threads.
2. `make ci-macos` is green on the v0.103.0 rc1 candidate's CI run.
