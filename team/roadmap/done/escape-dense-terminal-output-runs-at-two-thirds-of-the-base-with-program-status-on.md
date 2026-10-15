# Escape-dense terminal output runs at two thirds of the base with program status on

Status: measured and kept as a stated cost by the lead's ruling under the owner's accepted proposal 13 (escape-dense output at 0.872 of the feature-off throughput, plain at 1.015; the default stays off), and it did not ship a product change; closed at [v0.106.0](../../release/release-v0.106.0.md), which records the decision.

Record before the release: raised for v0.106.0 at the v0.105.0 GA on 2026-10-11, from the osc7501 round's Acceptance 8 record (survey 7) and the owner's reason for the default of off (decision 6); written down, not designed, not accepted for build.

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

## The profile and the two variants 2026-10-13

Acceptance 1 and 2 (the runtime seat, `dev/v0106-team/tasks/task-Runtime106-Lead106-12.md`; the plan written first in `reports/escthr-plan-Runtime106.md`; the evidence `evidence/Runtime106/escthr-1/`), measured in its 2-CPU guest at the integration tip `499aa3891` with the round's harness, corpus and protocol (4 KiB reads, 1,024 warm-up and 65,536 measured reads, seven alternating off and on pairs per corpus; the denominator the same binary with the feature off, set outside the measured region and proved by one report; all 84 observations kept and every ratio recomputed from the raw logs). The current framer: plain 1.015, escape-dense 0.872 of the feature-off throughput (the seven dense ratios 0.854 to 0.906), inside the 0.85 tolerance in this contended run; the historical 0.646 used the pre-feature binary as its denominator in a quiet four-CPU guest, so neither figure reproduces or replaces the other, and the difference cannot be attributed to an optimisation. The profile: `perf` is absent and non-root sampling refused (`perf_event_paranoid` 2), so the figures are counters and instrumented wall time from a separately compiled patch; on this corpus every 4 KiB read goes through one bulk skip, 493 ESC searches and 492 after-ESC span transitions and one final framing write, with no per-byte `advance` and no dispatch (the integration tip already carries the after-escape span and the CSI and OSC skip); the instrumentation perturbs the path (the instrumented dense ratio 0.24 against the native 0.87), so its percentages (ESC search 18, span transitions 18, the rest of the skip and timer overhead 40) are instrumented wall time, not native sample fractions. The two shapes the earlier round named, as scratch variants with the conformance tables run under each: a bulk skip for CSI and single-byte ESC sequences, 0.674 on the dense corpus (outside the tolerance), 90 of 90 conformance; the framer run only when the read holds an ESC, 0.869 but rejected by conformance (split reports lost; one assertion poisoned a held mutex and aborted the process, kept as a red). Neither supports a product change. No real-agent output was measured, so the owner's condition for saying the speed concern is gone is not met here.

Acceptance 3 is the owner's at the survey: the default stays off in v0.106.0 under the owner's standing proposal 13, with these figures beside the historical bound; the question put to him is whether to keep the default off (recommended, as measured) or to order a real-agent corpus measurement in a later round before any default change.
