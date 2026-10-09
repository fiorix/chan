# No bounded guest route harvests the Nix fixed-output hashes

Status: raised for v0.105.0 by the owner's word of 2026-10-09, from the v0.104.0 release report's follow-ups; written down, not designed, not accepted for build.

## What was seen

A version bump regenerates the lockfiles, so both Nix fixed-output hashes are harvested again at every bump, release candidates included ([the release procedure](../../../.agents/skills/release/SKILL.md), "Version pins", the paragraph "Harvest at every version bump"). For v0.104.0 both harvests ran on the development host by the owner's answer, after the guest route planned for the round failed at its first build.

**The attempt.** The route was a Nix client run as the user `ubuntu`, who is not root, inside the round's existing Ubuntu guest (2 CPUs, 6 GiB, a 44 GiB quota), with a private store under that user's home: `store=local?root=/home/ubuntu/nix-rc0/store` (line 5 of `dev/v0104-team/evidence/Hygiene104/jobs/rc0-nix-harvest-npm-01/log`). Its preflight passed on 2026-10-09, 00:44:50Z to 00:45:15Z (`dev/v0104-team/evidence/Hygiene104/rc0-nix-preflight-01.launch.status`, `rc=0`); the preflight's log (`dev/v0104-team/evidence/Hygiene104/jobs/rc0-nix-preflight-01/log`, 25 lines) reads `nix (Nix) 2.18.1`, `effective_nix_jobs=2 cores=2 sandbox=true`, `Store URL: local`, `store_ping_rc=0` and `flake_eval_rc=0`. The first real build, of `chan.npmDeps`, ran 00:59:08Z to 00:59:12Z and failed (`dev/v0104-team/tasks/task-Hygiene104-Lead104-60.md`, which quotes both status files). Nix planned and copied 46 paths from `https://cache.nixos.org` (log lines 13 to 105), started the derivation `chan-0.104.0-rc0-npm-deps.drv` (line 107) and ended at lines 108 to 110:

```text
error: builder for '/nix/store/c88j94mgxls9bd3q2w9h27r88ic1zng0-chan-0.104.0-rc0-npm-deps.drv' failed with exit code 1;
       last 1 log lines:
       > error: executing '/nix/store/c9mv5v53f7vy3wd00ah0f77k509mzmn7-bash-5.3p15/bin/bash': No such file or directory
```

The runner then recorded `nix_build_rc=1`, and the harvest's parser read "expected exactly one Nix fixed-output mismatch, found 0". No hash came out of it, and nothing was retried.

**What followed.** The lead asked the owner by survey. The first survey timed out; the second was answered at 02:34:47Z with `Host harvest (as v0.101-v0.103)`. The options not taken were a real `/nix` owned by `ubuntu` in the guest, the Nix daemon in the guest, and holding the candidate (`dev/v0104-team/reports/decisions-Lead104.md`, the section of 2026-10-09T02:35:10Z). The host harvest ran once with Nix 2.35.2 as the ordinary user in a throwaway store, 02:35:17Z to 02:35:40Z, exit 0 (`dev/v0104-team/reports/candidate-report-Lead104.md`, "RC0: the pin commit, its gate and the three publish=false dry runs"), and the GA commit re-pinned both hashes "from a second host harvest" (the [v0.104.0 report](../../release/release-v0.104.0.md), "Platform and pipeline"). That report's Follow-ups say "no working guest-only route was built in this round".

**The tracked route was not tried.** The release procedure's own guest route is `make nix-sdme-check`, which runs `packaging/nix/build-with-sdme.sh`: a disposable Ubuntu guest whose whole payload, Nix included, runs as root with `NIX_REMOTE=local` (lines 134 to 183 in the released tree `af2af8ac0`), created with a disk cap and with no CPU, memory or time limit (lines 189 to 195). [sdme-ubuntu-nix-build](../done/sdme-ubuntu-nix-build.md) records one such run green on 2026-08-05 (Ubuntu 26.04, Nix 2.34.3). In this round the candidate report says "the current sibling Nix driver is outside this repair scope and does not meet the team's guest bounds" ("Owner handover and RC0 preparation"), and the plan set that driver aside for the existing guest (`dev/v0104-team/reports/plan-Hygiene104-rc0-nix-hash-harvest.md`, "Prior disposable-driver route" and "Existing Hygiene guest native harvest assessment"), so it was not run. The same plan, written before the attempt, calls the private store's selector, ownership and sandbox behaviour in the Ubuntu package "unverified".

**Not established.** The cause. The task that reports the failure says the missing executable is a path the same log lists as fetched (line 70), that "the log alone does not establish why it was unavailable to the builder", that no sandbox, namespace or fallback warning appears in the log, and that "execution inside a sandbox is not established". The candidate report's reading, that the builder's bash is a store path "which a private store reaches only inside a namespace this guest does not give", is marked there as "the lead's inference from the log"; nothing was run to test it. Also not established: whether the tracked `make nix-sdme-check` works on the round's pool, or under added limits; whether either option the survey offered (a real `/nix` owned by the build user, the daemon in the guest) works; whether a newer Nix than the guest's 2.18.1 behaves differently (the log's two `warning: unknown setting 'build-dir'` lines, 6 and 106, show that version not knowing a setting the plan passed); and how the three previous versions harvested, beyond the survey option's own words, since their records were not opened for this item.

## Desired contract

Both fixed-output hashes of a version bump can be harvested inside a capped guest by a user who is not root, with nothing run on the host, and the release procedure names that route; or the item records why no such route holds, and the procedure names the host harvest with its bounds. A harvest that ends without exactly one expected mismatch stays red.

## What to do

Establish the cause before choosing a route. Repeat the failing build in a capped guest and make the failure say more: the full `nix log` of the derivation, the effective sandbox setting at build time, whether the builder's store path exists on disk under the private root when the build fails, and the same build with the store at a real `/nix`. Then try the candidates in order of least privilege, each once, each recorded red or green with its log: a real `/nix` owned by the build user, the Nix daemon in the guest with the build user as its client, and the tracked driver under added limits. Report which of them hold to the lead before the release procedure is changed.

## Boundaries

A guest only: no Nix build runs on the host for this item. `packaging/nix/build-with-sdme.sh` and its stub test if the tracked driver is the route (its limits are the subject of [sibling-sdme-build-drivers-set-no-cpu-memory-or-time-limit](sibling-sdme-build-drivers-set-no-cpu-memory-or-time-limit.md)), the section "Nix hashes on a host without Nix (sdme)" of `.agents/skills/release/SKILL.md`, and `packaging/nix/README.md`. The two derivations, the flake and the hash checks (`make nix-hash-check`, `make nix-hash-pin`) are unchanged. The Nix sandbox is not turned off to get a value, and a build run as root is not recorded as the route for a user who is not root; the plan set both rules before the attempt.

## Acceptance

1. A written cause for the failure of 2026-10-09, with the run that shows it; or "not reproduced", with the attempts and their logs.
2. In a guest whose CPU, memory and disk caps are read from the host, as a user who is not root, two harvest builds each end at exactly one fixed-output mismatch: the first names a `-npm-deps` derivation and the second a `-vendor-staging` one, each with its `got:` value; the logs and statuses are kept.
3. The two values equal the ones a host harvest gives for the same lockfiles, or the ones the `Nix chan-desktop` job of `ci.yml` accepts.
4. A failure that is not the expected mismatch (a builder error, a timeout, a missing status) is red under the route's script; shown on a constructed input before the real run.
5. The release procedure's section names the route, its prerequisites and its bounds, and says what to do when the route is refused.
6. If no guest route holds: the item says which candidates were tried and why each failed, and the procedure names the host harvest as the route.
