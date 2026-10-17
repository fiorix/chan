# Check 105's red in ten is not counted twenty times

Status: closed on 2026-10-17 by the count, twenty-nine of twenty-nine green, and the bound it supports; the section Counted twenty-nine times at two CPUs 2026-10-17 holds the record.

## What is open

The v0.106.0 item repaired what the check's own red could show (the request observer records every configuration write of the window, the late stored-mode sentence is selected under a flag) and landed it reviewed. The cause of the one red in ten, seen in the two-CPU count's whole run, is not established, and the item's acceptance 2, the file-order prefix through check 105 run twenty times with each red kept beside its sentence, was not met. Since that section was written the suite ran whole two more times at four CPUs (the second candidate and the landed tip `8b052cc6a`) with check 105 green each time; those are context, not the count, because the red occurred at two CPUs.

## What to do

Run the suite's file-order prefix through check 105 twenty times in the hygiene guest at two CPUs, the load the red occurred under, by the candidate-suite method with the observer's output kept, each run bounded, no retry, every red kept with its failure sentence, timeline and the window's recorded configuration writes; then read the reds against the observer's output and name the cause or the bound. A count at four CPUs is a second series, not a substitute.

## Boundaries

A count changes no check and no product file; a repair the count motivates is a row of its own.

## Acceptance

1. Twenty runs at two CPUs recorded with their statuses and the reds' sentences, the guest's caps and throttle share per run.
2. A cause named from the recorded writes, or a stated bound with the count that supports it, written into this item.

## Counted twenty-nine times at two CPUs 2026-10-17

The hygiene seat ran the suite's file-order prefix through check 105 (`10-close-pane` and checks 100 to 105, selected as `SMOKE_ONLY=10-,100-,101-,102-,103-,104-,105-`, since a bare `10` also selects 106 to 109) twenty-nine times in two series by the same loop: twenty back to back from 2026-10-16T23:57:32Z to 2026-10-17T00:06:47Z, then, on the lead's ruling for the nine that exclude a one-in-ten red, nine more from 2026-10-17T00:13:19Z to 00:17:26Z. Every run was at the v0.107.0 frozen candidate `989a76acb` with the candidate's own build (the bundle, debug `chan` and echo extension of the whole candidate run, every run refused unless their hashes match `build.manifest`), in `chan-v0107-hygiene` at two CPUs and 8 GiB, by the candidate-suite method: one guest job per series looping over its runs, each run under its own 900 s bound inside the guest, no retry, the request observer as it ships (every `/api/config` PATCH of the window during the custom-colours click recorded), and the unit cgroup and host pressure sampled every second.

Twenty-nine of twenty-nine runs exit 0, each with all seven checks passing. Check 105 took 13,973 to 15,442 ms by each run's `results.json` (14,633 in the whole candidate run at the same build); the runner's PASS lines, taken a few milliseconds earlier, read 13,966 to 15,434, median 14,204. There was no red, so no failure sentence, timeline or recorded configuration write to read, and no cause can be named from them.

The guest's cap and throttle share per run: `cpu.max` read `200000 100000` throughout every run; each run was throttled in 17 to 22 percent of its periods and used 0.70 to 0.81 cores on average. Over both series `memory.events max` did not move, `memory.current` stayed between 0.82 and 5.64 GiB, and the unit's swap peak did not move. Nothing else ran in the guest. Beside it, over the first series the integration guest used 147 CPU-seconds and the runtime guest 216, and over the second the integration guest used 338; host CPU pressure some avg10 reached 7.72 at most.

The bound: with no red in twenty-nine runs, the per-run red rate of this prefix at this build and load is below 9.8 percent at 95 percent confidence (one-sided, 1 - 0.05^(1/29)). That excludes the one red in ten seen at v0.106.0's integration commit at 95 percent: at that rate twenty-nine greens in a row have a 4.7 percent chance. The one in ten was counted on the same prefix at two CPUs, at another build (`ea4b04f18`) and before the observer landed; this count is at the v0.107.0 candidate.



Acceptance 1 is the twenty-nine runs with their statuses and the guest's cap and throttle share per run (`c105-1-table.md`, `c105-2-table.md`). Acceptance 2 is met by the stated bound with the count that supports it; no cause is named. The records are under `dev/v0107-team/evidence/Hygiene107/candidate-suite/` in the round's bus: `c105-loop.sh` (the same script for both series), `run.sh`, `guest-job.sh`, the jobs' `c105-1.{log,status,samples,beside}` and `c105-2.{log,status,samples,beside}`, each run's own log and `results.json` in the guest's exports (`artifacts-c105-1/candidate-suite/c105-NN.log` and `c105-NN/`, archive sha256 `dcea38dc...`; `artifacts-c105-2/candidate-suite/c105b-N.log` and `c105b-N/`, archive sha256 `b13f6375...`), and the two tables written by `c105-table.py`, which was run first on constructed input (a red's sentence listed, an empty job refused).

## The owner's word 2026-10-16

Asked at the cut through one survey that listed the thirteen rows not shipped and the seven findings outside any item, with the lead's recommendation on each, and offered each row's own question with its cost (this row's line: "c105ct, check 105's red in ten: carry (the count runs now if it finishes before the cut)"), the owner answered: "Take all fourteen recommendations as listed (Recommended)". The line carried the row for a count that did not finish before the cut; the count finished (twenty-nine of twenty-nine green, the section above) and meets both acceptances, so the row closes with the count as measured and moves to `done/` at the GA commit.
