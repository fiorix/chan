# The sdme build drivers have no measured defaults

Status: carried into v0.108.0 at the v0.107.0 GA on 2026-10-17, still raised for a decision.

Record before the release: raised by the lead at the v0.106.0 GA cut on 2026-10-15 from the open acceptances 3 and 4 of [Sibling sdme build drivers set no CPU, memory or time limit](../done/sibling-sdme-build-drivers-set-no-cpu-memory-or-time-limit.md), whose code shipped; written down, not designed, not accepted for build; owner the hygiene seat.

## What is open

The five sdme build drivers now source one policy of overridable CPU, memory, disk, job and time limits (`packaging/sdme-build-policy.sh`), with the kept-guest reuse, the contracts' isolation from the caller's environment and the reuse diagnostics landed and reviewed. The disk limit has its default from before the round (44G); no driver has a CPU, memory, job or time default yet: the measured runs that would set them (each driver once under a recorded cap, with its wall time, memory peak and disk use read from the host cgroup and the pool) were not reached, and the only run with the real tool was one `sdme set` probe by the lead. The lead's stated cost of a default stands: a cold build once a default exists takes about twenty minutes against a minute or two for the kept guest, by the desktop driver's own comment. The contracts keep one recorded gap for their next touch: five direct driver calls under the caller's policy names. Two hygiene follow-ups are kept as patches in the round's bus for their read: the one-CPU test series helper's test follow-up (row onecpu, commit `13beb790746fde13540f024b2f753cf266a501e9` on `v0106/hygiene`, unreviewed at the GA; `dev/v0106-team/evidence/Lead106/ga/carried-patches/onecpu/`) and the Windows cross-check driver's last guard-case comment (row rustup, commit `13860489b00d15e455a4ec804d529a1a8fed855c` on `v0106/hygiene`, the third range of its review, not reached; `dev/v0106-team/evidence/Lead106/ga/carried-patches/rustup/`).

## What to do

Run each driver once in a capped guest with the policy names exported, record the host cgroup's CPU periods, throttled share, memory peak and events and the pool's quota around it, then propose a default per driver from the readings with its margin, as the shipped item's design describes; close the contracts' recorded gap in the same change. A refused or failed run stays distinct from a pass. Read the two kept patches first and land or drop each with its reason.

## Boundaries

No default is written without the reading it rests on; the drivers' behaviour under an explicit knob does not change.

## Acceptance

1. One recorded run per driver with its readings and the policy values it ran under; a refused or failed run recorded as such, not as a pass.
2. A default per driver written into the policy with the reading it rests on, pinned by the contract tests; the five direct driver calls covered.
3. The two kept patches read: each landed with its review or dropped with its reason recorded.

## The owner's word 2026-10-16

Asked at the cut through one survey that listed the thirteen rows not shipped and the seven findings outside any item, with the lead's recommendation on each, and offered each row's own question with its cost (this row's line: "sibmsr, the sdme build drivers' defaults: carry"), the owner answered: "Take all fourteen recommendations as listed (Recommended)". The row moves to v0.108.0 at the GA commit with its record as it stands.
