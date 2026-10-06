# The browser suite stalls for ten to thirty-five seconds on a different check in every run

Status: accepted for diagnosis before further stability proof; no product repair is selected.

## Owner decision, 2026-10-06

Correlate check steps, every page's slow requests and console messages, server activity and guest resource counters on one timeline. Start with existing observability; add narrowly scoped server timing only where needed. Keep verdicts and timeouts unchanged. The probe must explain a real stall before selecting a repair; another passing run does not explain an earlier wait.

Lead clarification on the same date: record host enforcement and contention as well as guest observations.

## Record before this decision

Every section below records the state before the dated decision above and is preserved as history. The dated decision governs the current scope.

Previous status: raised for a decision on 2026-10-05, before the v0.102.0 GA, and listed under v0.103.0 from the start: the owner asked that day that what leaves v0.102.0 be put in the next version's list to be checked, and this is the lead's proposal for that list. `raised | decide`: not accepted and not built; the owner has not ruled on it and did not take it into v0.102.0, which shipped on 2026-10-05.

Raised by the lead from the twelfth pass on [the-browser-smoke-suite-is-red-at-the-base](the-browser-smoke-suite-is-red-at-the-base.md), which leaves a probe of these stalls as what the suite needs next and puts it to the owner. That item keeps its own row and its own acceptance in v0.102.0; this one is the probe alone. Every figure below is taken from the reports of the suite's runs in the build guest and from one reading of their result files, made at `adf953f6c` with nothing run. The result files were not opened again for this item, and nothing was run for it.

## Owner ruling

Not ruled. The owner was told in writing on 2026-10-05, with the state of the version's first release candidate, that the browser suite is not stable. The suite's own item says that the probe is put to the owner and waits for the owner's word; this item is where it is put. No ruling is recorded.

## What was seen

Seen in the runs of 2026-10-05, as the reading has them. A few checks in each run took ten to thirty-five seconds longer than their best time of the day, and not the same checks from one run to the next. The reading says so of the five whole runs it compared and of one pass of each check alone, and gives figures for four of the whole runs and for the pass. In the second whole run at `e5ede897d`: check 112 in 13.5 s against 3.6 s, check 30 in 36.1 s against 3.7 s. In the whole run at `ae81b1386`, which was green: check 15 in 37.0 s against 2.2 s, check 66 in 30.8 s against 9.4 s, check 99 in 24.6 s against 4.3 s, check 64 in 21.0 s against 1.5 s. In the first whole run at `adf953f6c`: check 106 in 36.0 s against 3.5 s, check 122 in 31.6 s against 1.2 s, check 50 in 18.6 s against 2.6 s. In the second: check 124 in 28.5 s against 1.4 s, check 107 in 20.0 s against 4.2 s, check 22 in 11.8 s against 1.1 s. In the pass of each check alone at that commit: check 106 in 34.6 s, check 112 in 24.1 s, check 103 in 16.2 s against 0.5 s.

Seen after that reading, from the report of the runs at `22c1e8fc8`, the commit of the second release candidate. The whole run there was green in 7 min 44 s, and by its report no check took more than three times its duration in the green run at `ae81b1386`, a run that has stalls of its own. In the pass of each check alone, check 80 took 18.0 s against 1.4 s in the pass at `adf953f6c` and check 64 took 5.8 s against 1.7 s; check 62 was red at `coalescing probe upload did not finish` after 151.7 s and green at its one rerun in 102.8 s.

What ran beside them. The two whole runs at `adf953f6c` held the lock of the guest's web jobs, under a memory cap of 4 GiB, while Rust jobs of another range ran in the guest. The whole runs at `e5ede897d`, `ae81b1386` and `22c1e8fc8` and the pass alone at `22c1e8fc8` each held the lock the guest's Rust jobs share, under 14 GiB, and are recorded with no other job running; the units at `22c1e8fc8` were started with a CPU quota of 800%. The log of the pass alone at `adf953f6c` names neither its lock nor what ran beside it. So a busy guest stands beside some of the stalls and not beside others.

One check has a count over three days. Of 59 green records of check 30 from 2026-10-03 to 2026-10-05, 41 took 0.9 to 7.9 s and 18 took 11.8 to 70.8 s, with none between, and 13 of those 18 are runs of the check alone; the count is recorded on [cs-export-hangs-where-the-ui-export-completes](cs-export-hangs-where-the-ui-export-completes.md). So that check's stall is not an effect of a whole run.

What the stalls have cost, in the reds the records name. Six reds are on record from 2026-10-05 in runs that changed nothing, forcing and mutation runs set aside: check 123 and check 54 in the two whole runs at `e5ede897d`, check 54 once more alone at that commit, check 30 and check 98 in the two whole runs at `adf953f6c`, and check 62 in the pass alone at `22c1e8fc8`. Four of the day's seven whole runs were red, each at one check, at four different checks; the first of the seven, at `d8c1d65ea` at 05:12Z, was green on all 49 checks the suite then had. One red is tied to a stall by its own times, and that is a reading and not an observation: check 30's, where the page's bound of thirty seconds on one slide ran out in a check that took 143.8 s against about 4 s, and whose first export, in a lone page, had already taken about 34 s where it takes about one. Of check 123's red its reading found about three seconds lost before the wait that failed, recorded nowhere. For checks 54, 98 and 62 no record says whether a stall was in the red: check 54's two reds have a defect of the suite's delay proxy beside them, repaired that day and not shown to be their cause; check 98's is read on [the-file-browser-keeps-a-tree-whose-root-is-gone](the-file-browser-keeps-a-tree-whose-root-is-gone.md), where one of three ways is a request cut off at the page's cap of ten seconds; check 62's was not read. Behind those reds three rows of v0.102.0 stand at build, whether or not a stall made the red each waits on: the suite's own, whose acceptance asks for a green whole run and a green pass of each check alone at one commit and has both at none, and the two that take check 123 as their proof, [a-windows-first-save-can-swallow-a-peers-unsent-split](a-windows-first-save-can-swallow-a-peers-unsent-split.md) and [a-window-misses-a-layout-saved-while-its-socket-was-down](a-window-misses-a-layout-saved-while-its-socket-was-down.md).

## Why it matters

A red of this suite cannot be classed today. If the stalls are the guest's, the suite cannot prove a change on this box as its acceptance is written, and a red that a stall made says nothing of the product. If they are the product's, they are waits a user can meet: the reading puts a `cs export` of a three-slide deck at 12 to 70 s where it takes about one, about one time in three in this guest, and its arithmetic on ten slow legs of that check puts the excess at the page's own caps of ten and of fifteen seconds and at their sums, which reads as a request or an event that never arrived and not as slow drawing. That is a reading of numbers. More runs do not decide between the two: each run so far has added a slow check or a red, and no cause.

## Desired contract

Not chosen: the owner's ruling decides whether anything is built. The lead proposes a probe, and not more runs: for a check that stalls or reds, the run's own record says what waited, so that the guest and the product can be told apart. It records three things on one clock. The reading names them for check 30; the proposal is to record them for any check. From the guest: the CPU quota and the memory cap of the run's unit as it was started, and the unit's throttle and pressure counters and its memory events, so that a stall can be set beside a throttled or a reclaiming unit. From the page: for every page of a check, the runner's own and any the check opens, each request slower than five seconds with its path, start, duration and status, and the console's warnings as well as its errors; the reading says the page's own resource timings give the requests with no change to the product. From the server: its log on the same clock, with a timed line where a page's count, upload or reply arrives, so that a request the page gave up on can be told from one the server never saw; those lines are a change to the product's log, and whether they are in is part of the ruling. The probe changes what a run records and not what passes: no retry and no longer wait.

## Boundaries

`scripts/e2e/browser-smoke/**`, as on the suite's own item, and whatever starts the suite's unit in the guest, for the unit's limits and counters. The server's log lines only if the ruling takes them in. Not the product's waits or caps, and not any check's bound. Not the records of [three-browser-checks-cannot-say-why-they-failed](three-browser-checks-cannot-say-why-they-failed.md), which are the same kind of record for three named checks and can be built without this.

## Acceptance

Left open until the owner rules.

1. The ruling is recorded: the probe is built, in v0.102.0 before its GA or in v0.103.0, or it is not built and the stalls are written as a cost of running the suite on this box.
2. If it is built: a run in which a check stalls or reds leaves, in its own record, which of the page, a request, the server or the guest waited, shown on one stall of a real run; and no check's verdict changes with the probe.
3. If the probe places a stall in the product, that wait gets an item of its own.

## Not established

Whether the stalls are the guest's or the product's: no record of any run holds the time of a step or of a request, or the pressure on the run's unit. What waited in any stalled check. Two slow checks left one trace each, a reply that the page posted after the server had stopped waiting for it and that was answered 404, in check 106 alone at `adf953f6c` and in check 66 in the green whole run at `ae81b1386`; the reading found no other log of a slow check with one, and the runner prints such lines for its own page alone. Whether the stalls are of one kind: they are grouped here by their size, and the sums of ten and fifteen seconds are arithmetic on ten legs of one check. Whether they happen outside this guest, on a machine with a display or in a user's browser. The CPU quota and the memory events of the units at `adf953f6c`, and whether the guest's temporary directory is memory or disk, were not read; the runs at `22c1e8fc8` recorded their units' limits as started and not their counters. The slow checks at `22c1e8fc8` are the two its report names against the pass at `adf953f6c`, and were not set against each check's best of the day as the reading's were. How often the guest's counters must be read to place a stall of ten seconds, and whether the probe lives in the runner or in what starts its unit, are not chosen. No report from use.
