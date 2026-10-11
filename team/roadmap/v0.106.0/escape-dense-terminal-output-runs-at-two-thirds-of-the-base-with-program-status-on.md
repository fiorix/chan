# Escape-dense terminal output runs at two thirds of the base with program status on

Status: raised for v0.106.0 at the v0.105.0 GA on 2026-10-11, from the osc7501 round's Acceptance 8 record (survey 7) and the owner's reason for the default of off (decision 6); written down, not designed, not accepted for build.

## What was seen

With the feature on, the server's output path feeds every read through the OSC 7501 framer (`crates/chan-library/src/terminal_sessions/program_status.rs`, `feed`). Measured in the round on a four-CPU guest with seven paired runs per corpus against the base `9820d2723`: plain output at 0.978 of the base's throughput and escape-dense output at 0.646 after two bounded optimizations (ESC-only search with a 16-byte inline compare before memchr; the per-byte state kept in place), against the item's 15 percent tolerance. The owner recorded the measured figures as the stated bound (survey 7) and set the feature's default to off (decision 6: "just in case theres unexpected bugs in the parser or anything tha would slow down the terminals"). With the flag off the framer's byte entry returns before any per-byte work. Records: `dev/osc7501-team/reports/measurements-Lead7501.md` and `evidence/Rust7501/task10/` in the round's archive.

Not established: the cost on a real agent session's output mix; whether the escape-dense corpus (every byte an ESC or near one) is representative of any program.

## Desired contract

The feature on costs no more than the item's tolerance on escape-dense output, or the owner records a different bound, so that the default can be on.

## What to do

Profile the framer under the escape-dense corpus (where the time goes: the per-byte `advance`, the dispatch, the lock); try the remaining shapes the round named and did not take (a bulk skip for CSI and single-byte ESC sequences before the per-byte advance; the framer run only when the read holds an ESC), each measured by the round's paired protocol with the raw observations kept; then the owner decides the default.

## Boundaries

`crates/chan-library/src/terminal_sessions/program_status.rs` (the framer) and `terminal_sessions.rs` (`record_output`); the measurement scripts of the round. Not changed: the protocol's conformance tables, which stay green.

## Acceptance

1. A profile of the framer on the escape-dense corpus, with the figures.
2. Each optimization tried measured by the paired protocol against the same base, raw observations kept, inside or outside the tolerance stated.
3. The owner's decision on the default recorded here, with the bound it rests on.
