# The sdme build drivers' rootfs checks race their own listing under pipefail

Status: built for v0.125.0 and carried in its first release candidate `0.125.0-rc0` (`67fd26b38`); the e2e runtime check's change has syntax and shellcheck coverage alone.

## What is there now

Five sdme drivers decide whether a rootfs exists with `$SDME fs ls 2>/dev/null | grep -qE "^${ROOTFS}[[:space:]]"` under `set -euo pipefail`: `packaging/sdme/build-chan-desktop.sh`, `packaging/gateway/scripts/dev/sdme/build-gateway.sh`, `packaging/gateway/scripts/dev/sdme/devserver-tunnel-e2e/build-bins.sh` (twice) and `devserver-tunnel-e2e/run.sh`. `grep -q` exits at the first matching line; when the listing has more lines after it, the writer can take SIGPIPE on its next write, the pipeline's status is the writer's, and the `||` branch builds or imports a rootfs that exists. The contract test `packaging/sdme/test-kept-build-driver.sh` drives the desktop, gateway and e2e drivers against a stub sdme whose listing is three lines; the stub refuses `fs build` and `fs import`, so the race shows as `running guest with one limit succeeds (expected 0, got 2)` or `killed build fails (expected 137, got 2)` followed by `stub sdme: unsupported fs call`. Whether the race fires depends on scheduling: the steps reran green alone in the same guest at the same sha. The arch driver reads its listing with `awk` and the copr, nix and windows-cross-check drivers capture it into a variable first, so they are sound.

## Desired contract

1. Every rootfs presence check reads the whole listing before it matches, so the length of the listing and the scheduling of the two processes cannot change the verdict.
2. A listing that fails still takes the rebuild or import path, as it does today; the checks' only change is that a successful listing is read to its end.
3. The contract test holds a listing long enough to fill the pipe behind an early-exiting reader, for each driver kind it drives, so the old shape fails every time and the new one passes every time.

## Boundaries

- The five driver scripts and their shared contract test; no change to the `.sdme` templates, the storage scanner or the gate's step list.
- No new dependency; no shell construct outside what `.shellcheckrc` admits.

## Acceptance

- The contract test's long-listing case red at the base on every run for the desktop, gateway and e2e kinds (the stub's listing holds the rootfs line first and tens of thousands of lines after it), green at the fix, with the existing cases unchanged.
- `make shell-check` and `make sdme-contract-check` green at the tip on a Linux host.

## Built

Two commits on `fix/sdme-build-driver-grep-race`: `ba662e008` (the desktop driver's check consumes its listing with `grep -E ... >/dev/null`, pipefail kept, and the shared stub gains a 100,000-record listing and a listing that exits after its match, driven by two desktop cases) and `fe06ed306` (the same shape at the gateway driver's check, the e2e driver's two checks and the e2e runtime's check; the stub selects each listing by invocation number; the gateway and e2e kinds gain the same cases).

Verification: the long-listing case red ten of ten at a test-only child of the base for the desktop, gateway and e2e kinds and green ten of ten at the fix; the failing-listing case red at mutants with pipefail removed; `make shell-check`, `make workflow-check` and three consecutive `make sdme-contract-check` runs green at the tip on the seat's host and on the lead's; `bash -n` on every changed file. The e2e runtime check's change has only syntax and shellcheck coverage, since no contract test drives that script.
