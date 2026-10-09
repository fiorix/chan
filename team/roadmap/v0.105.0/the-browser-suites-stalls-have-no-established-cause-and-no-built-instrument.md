# The browser suite's stalls have no established cause and no built instrument

Status: raised for v0.105.0 by the owner's word of 2026-10-09, from the v0.103.0 release report's follow-ups, which the v0.104.0 report does not repeat; written down, not designed, not accepted for build.

## What was seen

[the-browser-suite-stalls-on-a-different-check](../done/the-browser-suite-stalls-on-a-different-check.md) closed at v0.103.0 as withdrawn, with a partial measurement and no repair. Its record, by section:

- "What was seen": in the runs of 2026-10-05 a few checks in each run took ten to thirty-five seconds longer than their best time of the day, and not the same checks from one run to the next (check 30 in 36.1 s against 3.7 s, check 106 in 36.0 s against 3.5 s); six reds are on record that day in runs that changed nothing; and of 59 green records of check 30 over three days, 41 took 0.9 to 7.9 s and 18 took 11.8 to 70.8 s, with none between.
- "Measurements, 2026-10-06", "Partial post-live delay comparison, 2026-10-06" and "CPU attribution for the partial comparison, 2026-10-06": two slow document exports of check 30 were placed in the interval before upload (13,966 ms of 14,305 ms, and 68,757 ms of 70,708 ms), with the guest near its two-CPU quota (29.506 CPU seconds in a 14.938 s span with 147 throttled periods; 137.707 CPU seconds in 68.973 s with 687 of 690 quota periods throttled) and nearly all of the sampled CPU in one Chrome process. The record says this "does not establish why that work grew, which Chrome function performed it, or a product defect."
- "Root-list waits in check 62, 2026-10-06": a diagnostic variant of check 62 reached its probe timeout with 44 root listings totaling 13.754 s at a 300 ms median, against 256 listings at a 6 ms median in the passing control; the server logs kept could not split that wait between the server and the browser.
- "Record before the release": a later diagnostic run joined every root listing to one server span with handler medians under 5 ms without reproducing the waits or naming their cause, and the tracing instrument's 32 MiB buffer could not carry a trace as dense as its busy control, "so a short-slice stop or a sampling CPU profile, with a dense control, is the next instrument. No product repair is selected."

Those runs were headless Chrome in Linux guests, the measured legs of 2026-10-06 in a guest capped at two CPUs and 4 GiB; the v0.103.0 report describes the browser guest as having no GPU.

The v0.103.0 report left the choice open (`team/release/release-v0.103.0.md`, Follow-ups): "the browser-stalls item's next instrument (short-slice tracing with a dense control, or a sampling CPU profile) or the stalls carried as a cost", and whoever reopens the browser stalls "starts from a new item, with the closed item's record of what was observed." The v0.104.0 round did not take it up: a count made for this item finds no mention of the stalls, of tracing or of a sampling profile in `team/release/release-v0.104.0.md`. Neither instrument was built, and no cause was established.

What v0.104.0 changed beside it, without addressing it. The welcome now draws only 2D animations on a named software WebGL renderer and waits two seconds before it draws ([the-welcome-runs-webgl-on-a-software-context](../done/the-welcome-runs-webgl-on-a-software-context.md)), after a measurement in which a fullscreen WebGL2 animation used about two cores of a two-core quota on SwiftShader; the v0.103.0 report had tied check 62's two slow runs to Chrome's software WebGL fallback with both cores at their quota, as "an association" and "not a shown mechanism". And both browser matrices of the release passed every leg: a reading made for this item on 2026-10-09 from their joined summaries, with nothing run (`dev/v0104-team/evidence/Desktop104/browser/candidate-matrix-01.summary.json` and `ga-matrix-01.summary.json`), has four durations for each of the 59 checks (in the whole run and alone, at the candidate `c7178af66` and at the GA commit `af2af8ac0`), and no check's four durations differ by more than 3.4 s (check 105: 13.5, 13.9, 16.9 and 13.5 s). Those matrices ran Chrome for Testing 155 on SwiftShader, on binaries built in the guest by the instrument's preparation (debug builds at the candidate, by the candidate report), in a guest capped at 4 CPUs and 8 GiB as the only guest job.

What exists to measure with. The suite keeps a failure record since v0.103.0: bounded, token-masked timelines of page errors, slow or failed requests, listings, socket events, server lines and resource counters (`team/release/release-v0.103.0.md`, "Gate and browser suite", which adds that no red at that candidate exercised them). The instrument that ran the v0.104.0 matrices, with a host sampler that gives each leg its cores, throttled share and memory events, is in the round's evidence tree (`dev/v0104-team/evidence/Desktop104/browser/`: `dispatch.sh`, `acceptance.sh`, `verdict.py`, `host-sampler.py`) and is not a tracked file of the repository.

Not established: whether the stalls are the guest's or the product's (the closed item's section "Not established"); which Chrome function did the work in the slow exports; why the root listings were slow in the one check 62 red; whether the stalls still happen on the released tree, since four series on one day in a guest with twice the CPUs of the measured legs are a sample, and the owner's decision of 2026-10-06 on the closed item says another passing run does not explain an earlier wait; whether they happen outside this guest, on a machine with a display or a GPU, or in a user's browser. Nothing here was observed in a native webview.

## Desired contract

The item asks for the decision the v0.103.0 report left with the owner: build the next instrument the record names (short-slice tracing with a dense control, or a sampling CPU profile) and explain one real stall with it, or carry the stalls as a stated cost of running the suite on this box. If an instrument is built, a check that stalls or reds leaves in its own record which of the page, a request, the server or the guest waited, and no check's verdict or bound changes with it.

## What to do

Count before choosing: on the released tree, run the whole suite and each check alone several times under recorded caps, at two CPUs and at four, and say how many checks ran ten seconds or more over their best, with the reds kept. Put the choice to the owner with that count and the closed item's measurements. If an instrument is chosen, prove it first on a dense control it can carry without loss, then use it on a real stall; a passing run is not its result.

## Boundaries

`scripts/e2e/browser-smoke/**` and whatever starts the suite's unit in the guest, as the closed item's Boundaries have it; the matrix instrument, if it is brought into the repository for this. Server log lines only if the decision takes them in. Not changed: the product's waits and caps, and any check's assertion, bound or verdict. A stall that the instrument places in the product gets an item of its own.

## Acceptance

1. A count on the released tree: the number of whole runs and of runs of each check alone, the guest's CPU and memory caps, each leg's cores, throttled share and memory events, and how many checks ran ten seconds or more over their best; every red kept beside the greens.
2. The decision recorded here with that count: an instrument is built, and which one, or the stalls are carried as a cost with the sentence that says so in the suite's README.
3. If an instrument is built: its dense control is carried without loss, shown before it is used on a real run.
4. If an instrument is built: one stall of a real run is explained on one clock, naming which of the page, a request, the server or the guest waited; and a control run gives the same verdicts with the instrument attached and without it.
5. A stall placed in the product has a roadmap item of its own.
