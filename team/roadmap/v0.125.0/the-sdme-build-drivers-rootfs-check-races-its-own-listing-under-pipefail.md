# The sdme build driver's rootfs check races its own listing under pipefail

Status: raised by the lead on 2026-11-06 from gate run 3 of the v0.125.0 integration branch, where `make pre-push` stopped at the sdme contract check on the base's unchanged driver; accepted for v0.125.0 the same day; not started.

## What is there now

`packaging/sdme/build-chan-desktop.sh` runs under `set -euo pipefail` and decides whether to build its rootfs with `$SDME fs ls 2>/dev/null | grep -qE "^${ROOTFS}[[:space:]]"`. `grep -q` exits at the first matching line; when the listing has more lines after it, the writer can take SIGPIPE on its next write, the pipeline's status is the writer's, and the `||` branch builds a rootfs that exists. The contract test `packaging/sdme/test-kept-build-driver.sh` drives the driver against a stub sdme whose listing is three lines; the stub refuses `fs build`, so the race shows as `running guest with one limit succeeds (expected 0, got 2)` followed by `stub sdme: unsupported fs call`. Whether the race fires depends on scheduling: the step reran green alone in the same guest at the same sha.

## Desired contract

1. The rootfs presence check reads the whole listing before it matches, so the length of the listing and the scheduling of the two processes cannot change the verdict.
2. A listing that fails still takes the rebuild path, as it does today; the check's only change is that a successful listing is read to its end.
3. The contract test holds a listing long enough to fill the pipe behind an early-exiting reader, so the old shape fails every time and the new one passes every time.

## Boundaries

- One script and its contract test; no change to the other sdme drivers, to the `.sdme` templates or to the gate's step list.
- No new dependency; no shell construct outside what `.shellcheckrc` admits.

## Acceptance

- The contract test's new case red at the base on every run (the stub's listing holds the rootfs line first and tens of thousands of lines after it), green at the fix, with the existing cases unchanged.
- `make shell-check` and `make sdme-contract-check` green at the tip on a Linux host.
