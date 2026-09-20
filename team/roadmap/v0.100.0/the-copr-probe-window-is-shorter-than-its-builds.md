# The COPR publication probe times out before COPR finishes

Status: carried to v0.100.0. Raised for v0.99.0, from the v0.98.0 release; v0.99.0 changed neither the probe nor its window. One more measurement: on the v0.99.0 release both COPR jobs of `publish-downstream` finished green inside the window (run 35476612286), so the window is sometimes long enough and the item's question is how often.

## What was seen

`publish-downstream`'s two COPR jobs went red on the v0.98.0 release while both packages were building correctly. The probe reports its own limit accurately:

```
COPR build 10900793 for chan was still 'running' after 5400s;
its publication is UNCONFIRMED (not failed).
```

Both builds then succeeded at `0.98.0-1`, `chan` across ten chroots and `chan-desktop` across eight. Nothing was wrong with the packages, the source, or the trigger.

This item first read the expiry as build time creeping past the 5400 second window in `packaging/distros/copr/verify-copr-publication.sh`. The measurement taken on 2026-09-20 from COPR's `api_3` says otherwise. Across v0.89.0 to v0.99.0 without v0.98.0, `chan-desktop` took between 3089 and 4577 seconds from submission to end and `chan` between 1353 and 2087, with no trend, so every other release in that range fit the window. v0.98.0 was a COPR-wide slowdown that hit both packages at once in the queue and in the build phase: build 10900794 (`chan-desktop`) took 13986 seconds and build 10900793 (`chan`) 12003, and the next release was back in range. A window that covered it would be close to four hours, and `main` stays frozen for as long as the probe runs.

It was not the only such event. The same API lists builds back to v0.67.1, and two earlier releases ran past 5400 seconds as well: v0.76.1 on 2026-07-25 (`chan-desktop` build 10772737 took 25930 seconds, and the `chan` build beside it failed after 19842) and v0.82.0 on 2026-08-01 (`chan-desktop` build 10802362 took 6058 seconds, `chan` 5391). So a slow COPR day came about once a month over that stretch, one of the three would have fit a 7200 second window, and no window worth its freeze covers the other two.

The script's header is stale as well. It justifies 5400 seconds as about 1.67 times a worst total of 3237 seconds seen across v0.67.0 to v0.73.0. Against the worst normal total above the factor is 1.18 and the headroom 14 minutes. Rewriting that comment against current data is part of this item whichever shape is chosen.

## Why it matters more than a red square

Three costs, in increasing order of seriousness.

The release ends on a red that is not a failure, and a reader a year from now cannot tell that from the job list alone. That is exactly the "attributable" property the release process is supposed to guarantee for downstream targets.

The red cannot be cleared by re-running the job, because that job triggers before it verifies: its first step POSTs the COPR webhook. Re-running to get a green square submits a duplicate build of a version that is already published, so the honest response is to leave the red and confirm publication another way, which is what v0.98.0 did.

Most seriously, the probe is also the detector for a real hazard. `main` is frozen from the tag push until the probe confirms both packages, because the COPR SCM packages build main's HEAD on an empty committish and a push inside that window ships a package labelled with the tag but built from a later tree. A probe that times out routinely trains the next release to treat that red as normal, and the day it means the real thing, it will look identical.

## Desired contract

The probe's window is longer than a realistic COPR build for this project, and a timeout means something is actually wrong.

Whatever window is chosen is justified by the measurement above rather than by a round number, and the owner chooses between the shapes below with those numbers in hand.

Owner ruling, 2026-09-20, with the measurement above in hand: both. The job is split so that a trigger step and a separate verify step do not share a cell and verify can be re-run alone, and the window is raised to 7200 seconds, which restores a real margin over the worst normal release (1.57 times 4577 seconds) and would have covered v0.82.0. The stale header comment is rewritten against the current data as part of the same change.

The two shapes that were weighed. Raising the constant is the smallest change and keeps one mechanism. Splitting the job so a trigger step and a separate, independently re-runnable verify step do not share a cell is a larger change that also fixes the re-run problem, because verification could then be repeated without submitting a build.

## Boundaries

`packaging/distros/copr/verify-copr-publication.sh` and the `copr` job in `.github/workflows/publish-downstream.yml`.

The verify step is re-runnable in isolation today only outside CI: the script takes `COPR_OWNER`, `COPR_PROJECT`, `COPR_API_BASE`, `POSTED_AT`, `WEBHOOK_PRESENT` and `RELEASE_TAG` from the environment, which is how a real red can be reproduced for acceptance 2 without submitting a build. Splitting the job means duplicating the `if:` guard and the `PUBLISH` env onto the new job and promoting `posted_at` from a step output to a job output.

No change to the freeze rule itself, which is correct and load-bearing; this item is about making its detector trustworthy.

## Acceptance

1. A COPR publication that takes as long as v0.82.0's (6058 seconds) does not red the job. One that takes as long as v0.98.0's still expires as UNCONFIRMED, which no window worth its freeze prevents, and re-running the verify step alone once COPR has finished turns it green without a second webhook POST.
2. A genuine COPR failure, or a build whose version does not match the tag, still reds it. Prove this against a real red rather than by reading the script, because a detector nobody has watched fail is not a detector.
3. If the trigger and verify steps are split, the verify step can be re-run alone without POSTing the webhook a second time.
