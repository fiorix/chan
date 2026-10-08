# Six Low findings of the v0.102 Rust review are open

Status: accepted for v0.104.0 by the owner's word of 2026-10-08; each finding gets a disposition, repaired or stated as an observation, from its text in the v0102 archive. L8 (pin hygiene) is repaired, reviewed and landed on the integration branch on 2026-10-08 (see L8 landing); the other five dispositions follow.

## What was seen

The v0.102.0 report (`team/release/release-v0.102.0.md`, Follow-ups) leaves six of the last Rust review's nine Low findings open after rc1's two test pins and the rewrap of two commit messages: a join of tenant tasks with no bound of its own under the attempt lock, a hand-back marked and not delivered that stays marked, two gaps in the docs of the host and the server file, two guards with no series, and pin hygiene. The findings' text is in the v0102 archive (`../chan-dev/releases/v0102-team/`), not in the report: they are L3 to L8 of `reports/review-Runtime-24.md` there (L3 the join, L4 the hand-back, L5 the host's docs, L6 two sentences in the server file, L7 the two guards as one finding, L8 pin hygiene); L1 and L2 are rc1's two pins and L9 the rewrap.

## Desired contract

Each of the six has a disposition recorded in this item with the finding's text and location: repaired in this version with a test or a doc change, already repaired with the commit named, or an observation kept as written with its reason.

## What to do

Find the six findings' text in the archive and quote each with its path. Read each at source at the base. Dispose: a bounded join, an undelivered hand-back that clears its mark, the two doc gaps filled, the two guards given their series or their absence explained, and the pin hygiene applied, each as its own small commit where repaired; an observation where a repair is not warranted, with the reason.

## Boundaries

The files the findings name in `crates/chan-library/` and `crates/chan-server/` and their tests and docs; no change outside a finding's location.

## Acceptance

1. The six findings quoted with their archive paths and their source locations at the base.
2. A disposition per finding, each repair in its own commit with fmt, clippy and the whole crate suite green in the owning guest, each observation with its reason.
3. The reviewer reads the six dispositions against the archive text.

## L8 landing 2026-10-08

The runtime seat located and dispositioned the six findings (`dev/v0104-team/reports/report-Runtime104-item7.md`: L3 an observation with one sentence of cost; L4, L5 and L6 docs; L7 the two guard series as runs; L8 tests), confirmed by the lead. The sixth seat built L8 as one tests-only commit in the test modules of `crates/chan-library/src/host.rs` and `crates/chan-server/src/devserver.rs` (`dev/v0104-team/reports/report-Hygiene104-item7-L8-range.md`): the unhandled stale-handle leg, a present-token control and both overlay labels pinned, each edited leg shown able to fail by its own mutation with the checkout restored by hash, fmt, clippy and the whole `chan-library` and `chan-server` suites green at the tip (606 and 2,119 passed, three ignored). The reviewer accepted it with no blocking finding (`dev/v0104-team/reviews/review-Review104-item7-l8-1.md`, the counts recounted). The lead landed it by cherry-pick at `7e69131274fbd32a024804736dffde1daf81dee3` after a rehearsal with an equal tree, rewrapping the commit message's one wide line with its words unchanged. Still open: L7's two series of two hundred runs each under their own slot, and L3 to L6 as one docs range after the runtime seat's ranges on the same files.
