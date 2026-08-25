# The COPR publication probe times out before COPR finishes

Status: raised for v0.99.0, from the v0.98.0 release.

## What was seen

`publish-downstream`'s two COPR jobs went red on the v0.98.0 release while both packages were building correctly. The probe reports its own limit accurately:

```
COPR build 10900793 for chan was still 'running' after 5400s;
its publication is UNCONFIRMED (not failed).
```

Both builds then succeeded at `0.98.0-1`, `chan` across ten chroots and `chan-desktop` across eight. Nothing was wrong with the packages, the source, or the trigger. The 5400 second window in `packaging/distros/copr/verify-copr-publication.sh` is simply shorter than COPR's current build time for this project, which ran past 95 minutes.

## Why it matters more than a red square

Three costs, in increasing order of seriousness.

The release ends on a red that is not a failure, and a reader a year from now cannot tell that from the job list alone. That is exactly the "attributable" property the release process is supposed to guarantee for downstream targets.

The red cannot be cleared by re-running the job, because that job triggers before it verifies: its first step POSTs the COPR webhook. Re-running to get a green square submits a duplicate build of a version that is already published, so the honest response is to leave the red and confirm publication another way, which is what v0.98.0 did.

Most seriously, the probe is also the detector for a real hazard. `main` is frozen from the tag push until the probe confirms both packages, because the COPR SCM packages build main's HEAD on an empty committish and a push inside that window ships a package labelled with the tag but built from a later tree. A probe that times out routinely trains the next release to treat that red as normal, and the day it means the real thing, it will look identical.

## Desired contract

The probe's window is longer than a realistic COPR build for this project, and a timeout means something is actually wrong.

Whatever window is chosen should be justified by measurement rather than by a round number: the v0.98.0 builds are one data point at over 95 minutes, and the previous releases' durations are available from the COPR API for the same packages.

Two shapes worth weighing. Raising the constant is the smallest change and keeps one mechanism. Splitting the job so a trigger step and a separate, independently re-runnable verify step do not share a cell is a larger change that also fixes the re-run problem, because verification could then be repeated without submitting a build.

## Boundaries

`packaging/distros/copr/verify-copr-publication.sh` and the `copr` job in `.github/workflows/publish-downstream.yml`.

No change to the freeze rule itself, which is correct and load-bearing; this item is about making its detector trustworthy.

## Acceptance

1. A COPR publication that takes as long as v0.98.0's does not red the job.
2. A genuine COPR failure, or a build whose version does not match the tag, still reds it. Prove this against a real red rather than by reading the script, because a detector nobody has watched fail is not a detector.
3. If the trigger and verify steps are split, the verify step can be re-run alone without POSTing the webhook a second time.
