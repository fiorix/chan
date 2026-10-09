# The one-CPU test series helper refuses a guest outside the default sdme state directory

Status: raised for v0.105.0 by the owner's word of 2026-10-09, from the v0.104.0 release report's known gaps; written down, not designed, not accepted for build.

## What was seen

`scripts/e2e/one-cpu-test-series.sh` was run once in the v0.104.0 round, on Linux on the development box, against the guest `chan-v0104-hygiene` after the lead had set that guest to one CPU (`dev/v0104-team/reports/report-Hygiene104-item7-L7-series.md`, "One-CPU instrument and limits"). It refused before any test ran, exit 2, with the one line `one-cpu-series: REFUSED: missing exact sdme state: /var/lib/sdme/state/chan-v0104-hygiene` (`dev/v0104-team/evidence/Hygiene104/item7-l7-repo-helper.log`; the status file beside it reads `rc=2`, with start and end both at 2026-10-08T10:21:20Z). The call was `sudo -n scripts/e2e/one-cpu-test-series.sh --container chan-v0104-hygiene --package chan-server a_superseded_mount_keeps_a_ 1 8` (`dev/v0104-team/evidence/Hygiene104/try-item7-l7-repo-helper.sh`).

The round's guests lived on a storage pool the team built, with its own sdme configuration (the [v0.104.0 report](../../release/release-v0.104.0.md), "Team and process"), and that configuration's first line is `datadir = "/var/lib/sdme-v0104"` (`dev/v0104-team/sdme.conf`). The helper fixes the state file's place: `STATE=/var/lib/sdme/state/$CONTAINER`, and a refusal when that is not a regular file (lines 140 and 141 in the released tree `af2af8ac0`); it takes no option and reads no variable that names another directory. From that file it reads the guest's name, backend and disk cap (lines 142 to 147). Past that point it also fixes the unit `sdme@$CONTAINER.service` (line 148), the host cgroup `/sys/fs/cgroup/machine.slice/sdme@$CONTAINER.service` (line 153), a bare `sdme exec` with no configuration argument (lines 69 and 82), root's home and a clean checkout at `/work/chan` in the guest (lines 69 to 78). `scripts/e2e/README.md` ("One-CPU test series") documents that fixed shape and creates its guest with a plain `sudo sdme create`.

The round ran a stand-in instead: 200 iterations of two guard tests under a host-verified `cpu.max` of `100000 100000`, all green. The same report says the stand-in "does not claim the repository helper's own state, disk and throttle-counter acceptance bar", and the v0.104.0 report's Known gaps repeat it: "that helper's full acceptance bar is not claimed".

Not established: whether the helper would have passed its later checks had the state path matched. Only its first refusal was reached, so the unit name, the cgroup path, the bare `sdme exec` and the `/work/chan` checkout were never tried against a guest under a second sdme configuration; the round's guest ran its jobs as the user `ubuntu` from a guest-private checkout (the report's "Hand-back" and "Method and raw evidence"), which the report does not place at `/work/chan`. How sdme names a guest's unit and cgroup under a non-default data directory was not read. No other host and no other sdme version was tried.

## Desired contract

The helper measures a guest wherever its sdme state lives and proves there what it proves today (a btrfs backend, a disk cap, a running guest, an exact one-CPU cap read from the host, the throttle counter, a clean and unmoving revision); or it refuses in a sentence that says it supports the default layout only, and its documentation says so. The item asks for a decision between the two.

## What to do

Reproduce the refusal with a constructed state directory (the helper's own test, `scripts/e2e/test-one-cpu-test-series.sh`, already sources its functions), then against a real guest created under a second sdme configuration. Read how the installed sdme exposes a configuration's data directory and how it names the guest's unit and cgroup there, and do not assume either. List each fixed assumption past line 141 and what it would have met under the round's layout. Then put the choice to the lead: an option that names the configuration or the state directory, with every later check derived from it; or the documented limit.

## Boundaries

`scripts/e2e/one-cpu-test-series.sh`, `scripts/e2e/test-one-cpu-test-series.sh` and the "One-CPU test series" section of `scripts/e2e/README.md`. The helper's proofs are not weakened: no path reports a rate without a host-verified one-CPU cap, a disk cap and a clean revision. `scripts/check-sdme-storage.py` and its inventory stay green. No host's sdme configuration is changed.

## Acceptance

1. Given the state of a guest under a non-default data directory, the helper either runs its series or refuses in a sentence that names the unsupported layout; pinned in the helper's test, red first against the behaviour of line 141 today.
2. If support is built: one real series of at least one run against a guest under a second configuration, whose final line reads the container, backend, disk cap, `cpu.max` and throttle delta from that guest's own state and cgroup, beside a control run showing that a guest in the default layout still passes.
3. If support is built: every refusal the helper has today (an absent or non-one-CPU cap, a non-btrfs or uncapped root, a dirty or moving revision, a selector that names no test) still refuses under the new option; pinned.
4. `scripts/e2e/README.md` says which layouts the helper supports.
5. `make shell-check` is green at the commit.
