# The AUR check's release test build is killed with its hosted runner

Status: raised for a decision on 2026-09-28 by the lead, from main CI's runs of three landings and a measurement of the same compile on the development box. The two kills that kept a log are read in the jobs' own logs, and the memory on the box is measured; the hosted runner's memory, the number of compilers it runs, and why it was shut down are not known, so that the kills are its memory is inferred. Recommendation: accept for v0.101.0 and decide the bound.

## What was seen

**The job.** Main CI's `AUR build + smoke (chan)` runs on a hosted `ubuntu-latest` runner and calls `packaging/distros/arch/build-in-ci.sh` (`.github/workflows/ci.yml:228-255`), whose `docker run` hands an Arch container a fixed list of variables (`packaging/distros/arch/build-in-ci.sh:55-62`), and the container runs `makepkg` on the recipe (`packaging/distros/arch/build-in-container.sh:96`). The recipe's `check()` runs `cargo test --frozen --release -p chan` in the target directory `build()` used (`packaging/distros/arch/aur/chan/PKGBUILD.in:37-44`, `:46-52`), so it compiles again, in the release profile, a part of the workspace that `build()` compiled, `chan-workspace`, `chan-library` and `chan-server` among it (`dev/v0101-team/evidence/int/ci-36383441436/job-108803762923-aur-chan.log:1785-1797` in the development tree), and then `chan`'s test binaries, its eight integration tests among them, each of which runs the `chan` binary (`CARGO_BIN_EXE_chan` in each file under `crates/chan/tests/`). Nothing sets its job count, so cargo runs as many compilers as the CPUs the container sees, which is cargo's default and inferred here.

**Three reds in twelve landings**, 17 to 28, each on `main`:

- **Landing 17** (run 36270194197): the job's runner died 94 minutes into the step that builds, installs and smokes the package, with no log kept and the annotation that the hosted runner lost communication with the server. Where in the recipe it stopped is not known. The same run's Windows job was red for a fault of its own, and the run was judged by the next landing's.
- **Landing 26** (run 36343935990, job 108689253557): `build()` took 16 minutes 53 seconds, `check()` printed `Compiling chan` at 19:39:09Z, and at 19:58:38Z the `docker run` was killed and the runner wrote that it had received a shutdown signal, exit 143; no test had run, and the run's eight other jobs were green. The job run again was green (job 108696519728), its `check()` compiling for 19 minutes 11 seconds.
- **Landing 28** (run 36383441436, job 108803762923): `build()` took 16 minutes 45 seconds, `check()` printed `Compiling chan` at 06:06:19Z, and at 06:19:50Z the `docker run` was killed, exit 137, with the same shutdown line; no test had run, and the run's eight other jobs were green. The job run again was green (job 108813728405), its `check()` compiling for 23 minutes 39 seconds.

The records are `dev/v0101-team/journals/journal-Lead.md` in the development tree, the entries that name these runs, and the logs of both attempts of the last two, `dev/v0101-team/evidence/int/ci-36343935990/` and `ci-36383441436/`. The two logs name no cause, and landing 26's check-run annotations carry the exit code alone (`ci-36343935990/README.md`).

**What the same compile holds on the development box.** Uncapped, on the night of 2026-09-27, the lead's records read four of its compilers at 2.4G to 2.6G each with two more beside them, and that build beside a full gate took all of the box's 22G, with no swap, and the box down (`journal-Lead.md`, the entries of 2026-09-28 05:10Z and 06:31Z). Bound to three CPUs on 2026-09-28, in a build of the recipe at `6ea316868`, whose `check()` runs the same command as at `30ffb8027`, the package build never ran more than three compilers at once; a sampler that read them every 15 seconds from 06:49Z, with `check()` begun, until 07:24Z, when none was left, read them at up to 12,519 MB of resident memory together (at 07:06:46Z), 11,383 to 11,691 MB at most readings from 07:10Z to 07:15Z, and one compiler alone at up to 7,838 MB (at 07:21:06Z) (`dev/v0101-team/evidence/int/aur-cap-memory-0928.log`, whose header names its columns). Under that bound and beside other jobs, that build's `prepare()` and `build()` ended about 30 minutes after it started, and its `check()`, install and smoke about 36 minutes after that (`dev/v0101-team/evidence/Services/s26-capped-milestones.log`).

**Inferred and not measured:** the hosted runner's memory and the number of compilers it runs, and that the kills are its memory and not its loss for another reason.

**Two more reds on one commit, added on 2026-09-28.** Main CI's run for landing 31 (run 36443211816, on `90854b079`) was red at this job on both of its attempts. On attempt 1 (job 108998746373) the log's last compile line is `Compiling chan v0.100.0` at 15:43:32Z, in the release build of the test binaries, and at 16:05:53Z the `docker run` was killed, exit 137, with the runner's line that it had received a shutdown signal; no test had run (`dev/v0101-team/evidence/int/ci-36443211816/README.md` in the development tree). On attempt 2 (job 109017532962) the job ran from 16:07:11Z to 17:23:25Z, 76 minutes, and ended with its step "Build, install, and smoke" still in progress, its log gone and the annotation that the hosted runner lost communication with the server, as landing 17's did, so where in the recipe it stopped is not known (the job's steps and annotations read through the GitHub API on 2026-09-28; its log answers that the blob does not exist). The same run's AUR build of chan-desktop was green on attempt 1. So from landing 17 to landing 31 the job was red five times: three kills in `check()`'s release test compile with a log, at landings 26, 28 and 31, and two runners lost with no log, at landings 17 and 31. The run for the landing after it (run 36456494479, on `ebe9f7f62`) had this job green after 42 minutes; its one red job, the AUR build of chan-desktop, failed in its tests and was no kill, which is [the-root-stall-names-a-step-by-symbols](the-root-stall-names-a-step-by-symbols.md).

## Desired contract

The AUR build of `chan` on a hosted runner finishes its `check()` on every run, with what that check proves written where it is bounded. How it is bounded is the owner's to choose, from the ways below.

## What to do

The owner chooses; the lead recommends none of them over another beyond what each keeps:

- **A bound on the job count of `check()` in the CI wrapper**, carried by `build-in-ci.sh` into the container and on to the recipe's cargo. It keeps what the check proves, the same tests of the same release build, and costs time: fewer compilers compile longer, by how much on a runner not measured. The published recipe is unchanged, so an AUR user's build keeps its own job count.
- **A debug test build in `check()`**: it changes what the check proves, since its tests then run against a build other than the release build the package installs.
- **Fewer test binaries**, the library's own tests or a named subset: it changes what the check proves, since the integration tests are what run the `chan` binary.

Whichever is chosen, a log line before `check()` of the CPUs and the memory the container sees, and of the job count cargo will use, would let the next kill be read against them.

## Boundaries

`packaging/distros/arch/build-in-ci.sh`, and `packaging/distros/arch/build-in-container.sh` if the bound is carried through it; `packaging/distros/arch/aur/chan/PKGBUILD.in` only if the owner chooses to change what `check()` builds, in which case the packaging check that reads `check()` ([the-aur-check-could-ship-a-test-only-feature](the-aur-check-could-ship-a-test-only-feature.md)) applies to it; `.github/workflows/ci.yml` only if the bound is set there.

## Acceptance

1. The owner's choice is in place, and what `check()` still proves and what the bound costs are written where it is set.
2. The job logs, before `check()`, the CPUs and the memory the container sees and the job count cargo uses.
3. One run of the job with the bound, on a hosted runner, finishes `check()` with its tests run, and its time is recorded against the runs above.
