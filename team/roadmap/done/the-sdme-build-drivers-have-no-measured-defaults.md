# The sdme build drivers have no measured defaults

Status: shipped in [v0.109.0](../../release/release-v0.109.0.md).

Record before the release: built on 2026-10-22 on the seat's branch; the section Built 2026-10-22 holds the evidence; it closes at the GA as shipped.

Record before the build: carried into v0.109.0 at the v0.108.0 GA on 2026-10-21, still raised for a decision.

Record before the release: carried into v0.108.0 at the v0.107.0 GA on 2026-10-17, still raised for a decision.

Record before the release: raised by the lead at the v0.106.0 GA cut on 2026-10-15 from the open acceptances 3 and 4 of [Sibling sdme build drivers set no CPU, memory or time limit](sibling-sdme-build-drivers-set-no-cpu-memory-or-time-limit.md), whose code shipped; written down, not designed, not accepted for build; owner the hygiene seat.

## What is open

The five sdme build drivers now source one policy of overridable CPU, memory, disk, job and time limits (`packaging/sdme-build-policy.sh`), with the kept-guest reuse, the contracts' isolation from the caller's environment and the reuse diagnostics landed and reviewed. The disk limit has its default from before the round (44G); no driver has a CPU, memory, job or time default yet: the measured runs that would set them (each driver once under a recorded cap, with its wall time, memory peak and disk use read from the host cgroup and the pool) were not reached, and the only run with the real tool was one `sdme set` probe by the lead. The lead's stated cost of a default stands: a cold build once a default exists takes about twenty minutes against a minute or two for the kept guest, by the desktop driver's own comment. The contracts keep one recorded gap for their next touch: five direct driver calls under the caller's policy names. Two hygiene follow-ups are kept as patches in the round's bus for their read: the one-CPU test series helper's test follow-up (row onecpu, commit `13beb790746fde13540f024b2f753cf266a501e9` on `v0106/hygiene`, unreviewed at the GA; `dev/v0106-team/evidence/Lead106/ga/carried-patches/onecpu/`) and the Windows cross-check driver's last guard-case comment (row rustup, commit `13860489b00d15e455a4ec804d529a1a8fed855c` on `v0106/hygiene`, the third range of its review, not reached; `dev/v0106-team/evidence/Lead106/ga/carried-patches/rustup/`).

## What to do

Run each driver once in a capped guest with the policy names exported, record the host cgroup's CPU periods, throttled share, memory peak and events and the pool's quota around it, then propose a default per driver from the readings with its margin, as the shipped item's design describes; close the contracts' recorded gap in the same change. A refused or failed run stays distinct from a pass. Read the two kept patches first and land or drop each with its reason.

## Boundaries

No default is written without the reading it rests on; the drivers' behaviour under an explicit knob does not change.

## Acceptance

1. One recorded run per driver with its readings and the policy values it ran under; a refused or failed run recorded as such, not as a pass.
2. A default per driver written into the policy with the reading it rests on, pinned by the contract tests; the five direct driver calls covered.
3. The two kept patches read: each landed with its review or dropped with its reason recorded.

## The owner's word 2026-10-16

Asked at the cut through one survey that listed the thirteen rows not shipped and the seven findings outside any item, with the lead's recommendation on each, and offered each row's own question with its cost (this row's line: "sibmsr, the sdme build drivers' defaults: carry"), the owner answered: "Take all fourteen recommendations as listed (Recommended)". The row moves to v0.108.0 at the GA commit with its record as it stands.

## Contract gap repaired 2026-10-21

The four COPR and one Nix contract calls outside their `run_driver` helpers clear the same `SDME_BUILD_DISK` and per-driver policy names as those helpers before setting each case's variables. With `SDME_BUILD_COPR_MEMORY=2X` or `SDME_BUILD_NIX_MEMORY=2X` inherited at `8988cd38b`, the contracts exit 1 at the signal fixtures rather than testing their intended behavior (`dev/v0109-team/evidence/Hygiene109/sibmsr/gap/{copr,nix}-red-first.{log,status}`). With the repair applied, both direct contract scripts exit 0 under the same sentinels (`{copr,nix}-fixed-precommit.{log,status}`); removing each clearing guard alone makes its own case fail, four COPR and one Nix (`mutants.{log,status}`, five mutants red).

At this commit, in the capped hygiene guest, `make sdme-contract-check` exits 0 with no caller policy, with all eleven relevant caller policy names exported to valid values, and with all eleven exported to invalid `2X` values (`dev/v0109-team/evidence/Hygiene109/sibmsr/gap/final-{plain,valid,invalid}.{log,status}`). `make shell-check` and `make workflow-check` also exit 0 at this commit (`final-{shell-check,workflow-check}.{log,status}`).

The kept one-CPU patch is committed at `7d797a6cb`: its standalone `bash scripts/e2e/test-one-cpu-test-series.sh` has no make target and reports 99 PASS, 0 FAIL and 30 single-guard mutants red at that commit in the guest (`dev/v0109-team/evidence/Hygiene109/sibmsr/patches/onecpu-committed.{log,status}`); the helper's cap refusal names the observed `cpu.max`. The kept rustup patch is committed at `8988cd38b`: it records why the duplicate-channel fixture runs last, and `make shell-check` exits 0 at that commit (`patches/rustup-shell-check.{log,status}`). No driver default moves here; the measured driver runs and their sizing decisions remain open under the Status line.

## Built 2026-10-22

The six runs use the clean source at `1951965a3176e61583d792a42f6accf734276108`, sdme 0.20.1 and a host cgroup at 2 CPUs and 8 GiB memory; each wrapper sets 2 CPUs, 8G memory, 96G disk and 2 jobs, with the per-run timeout below. Each wrapper, driver and sampler exits 0, and each `driver/driver.status` classifies the run as `pass`. The sampler summaries and each run's `sha256` record the guest's cgroup and qgroup readings separately from host load. These timings were measured on a loaded host beside integration gates, so they size a bound at the measured 2-CPU setting rather than predict an unloaded wall time.

E2E_BINS passes with a 3600-second policy timeout: 558.1 wall seconds, 888.0 CPU seconds, 490 of 5344 CPU periods throttled (9.17%), 3.80 GiB memory peak, 0.50 GiB swap peak, no memory-max events and 1.71 GiB referenced qgroup peak. Host load1 reaches 9.27 and host CPU some pressure reaches 39.78% in the same sampling window. Evidence: `dev/v0109-team/evidence/Lead109/sibmsr/runs/E2E_BINS/` (`wrapper.log`, `wrapper.status`, `driver/driver.status`, `sampler.status`, `sampler/summary.json`, `sha256`).

GATEWAY passes with a 7200-second policy timeout: 273.6 wall seconds, 430.6 CPU seconds, 326 of 2422 periods throttled (13.46%), 4.51 GiB memory peak, 0.15 GiB swap peak, no memory-max events and 1.33 GiB referenced qgroup peak. Host load1 reaches 8.35 and CPU some pressure reaches 18.74%. Evidence: `dev/v0109-team/evidence/Lead109/sibmsr/runs/GATEWAY/` with the same wrapper, driver, sampler and hash files.

DESKTOP passes with a 7200-second policy timeout: 1199.8 wall seconds, 1940.9 CPU seconds, 1330 of 11679 periods throttled (11.39%), 4.07 GiB memory peak, 1.26 GiB swap peak, no memory-max events and 2.71 GiB referenced qgroup peak. Host load1 reaches 19.94 and CPU some pressure reaches 74.49%. Evidence: `dev/v0109-team/evidence/Lead109/sibmsr/runs/DESKTOP/` with the same wrapper, driver, sampler and hash files.

NIX passes with a 10800-second policy timeout: 1366.5 wall seconds, 2172.8 CPU seconds, 1150 of 13621 periods throttled (8.44%), the 8 GiB memory cap met with 1.17 GiB swap peak and 12452 memory-max events, and 5.51 GiB referenced qgroup peak. There are no OOM or OOM-kill events. Host load1 reaches 11.35 and CPU some pressure reaches 56.41%. The capped memory peak is a lower bound on demand. Evidence: `dev/v0109-team/evidence/Lead109/sibmsr/runs/NIX/` with the same wrapper, driver, sampler and hash files.

AUR passes with a 7200-second policy timeout: 4103.3 wall seconds, 6842.5 CPU seconds, 2340 of 40659 periods throttled (5.76%), the 8 GiB memory cap met with 6.13 GiB swap peak and 43196 memory-max events, and 1.78 GiB referenced qgroup peak. There are no OOM or OOM-kill events. Host load1 reaches 19.43 and CPU some pressure reaches 68.64%. The capped memory peak is a lower bound on demand. Evidence: `dev/v0109-team/evidence/Lead109/sibmsr/runs/AUR/` with the same wrapper, driver, sampler and hash files.

COPR passes its three targets in sequence with a 14400-second policy timeout. The el9 chan target takes 792.3 wall and 1268.4 CPU seconds, 236 of 7908 periods throttled (2.98%), 5.96 GiB memory and 0.03 GiB swap peaks, no memory-max events, and 1.84 GiB referenced qgroup; host load1 reaches 22.53 and CPU some pressure 61.94%. The el10 chan target takes 745.8 wall and 1060.2 CPU seconds, 836 of 7065 periods throttled (11.83%), 5.71 GiB memory and 2.44 GiB swap peaks, no memory-max events, and 1.89 GiB referenced qgroup; host load1 reaches 7.89 and CPU some pressure 76.54%. The el10 chan-desktop target takes 1004.4 wall and 1511.4 CPU seconds, 920 of 9775 periods throttled (9.41%), meets the 8 GiB memory cap with 0.62 GiB swap peak and 413 memory-max events, and reaches 2.68 GiB referenced qgroup; host load1 reaches 12.24 and CPU some pressure 81.18%. None has an OOM or OOM-kill event. The three measured wall times sum to 2542.5 seconds; the capped desktop memory peak is a lower bound on demand. Evidence: `dev/v0109-team/evidence/Lead109/sibmsr/runs/COPR/` (`wrapper.log`, `wrapper.status`, `driver/driver.status`, `sampler.status`, `sampler/summary.json`, `sampler-el10-chan.status`, `sampler-el10-chan/summary.json`, `sampler-el10-chan-desktop.status`, `sampler-el10-chan-desktop/summary.json`, `sha256`).

The first COPR attempt stops before a guest appears: the driver records exit 127 at `build-srpm.sh:107` because `docker` is absent, the wrapper exits 2 and the three samplers have no reading. It is a failed prerequisite attempt, separate from the pass above. The relaunch sets `DOCKER=podman` in `dev/v0109-team/evidence/Lead109/sibmsr/runs/COPR/driver.env.txt`; the attempt is recorded at `dev/v0109-team/evidence/Lead109/sibmsr/runs/COPR-attempt-1/` (`wrapper.log`, `wrapper.status`, `why.txt`).

Each default keeps the measured 2-CPU cap and sets jobs to 2. Memory adds the measured memory and swap peaks, rounds up to the next whole GiB and adds 1 GiB; where the run met the 8 GiB cap, the cap is the lower-bound memory term. The timeout doubles measured wall time at 2 CPUs and rounds up to the next 1800 seconds; COPR uses the sum of its three targets. The four drivers with a disk fallback keep 44G, above their 1.78 to 5.51 GiB referenced peaks; GATEWAY and E2E_BINS retain no disk default. Exported nonempty per-driver values override these defaults, and an exported empty CPU, memory, jobs or timeout value clears that default and emits the existing gap line.

| Driver | CPUs | Memory | Jobs | Timeout (s) | Memory basis |
| --- | ---: | ---: | ---: | ---: | --- |
| AUR | 2 | 16G | 2 | 9000 | 8G cap + 6.13 GiB swap |
| COPR | 2 | 10G | 2 | 5400 | el10 desktop: 8G cap + 0.62 GiB swap |
| NIX | 2 | 11G | 2 | 3600 | 8G cap + 1.17 GiB swap |
| DESKTOP | 2 | 7G | 2 | 3600 | 4.07 GiB + 1.26 GiB swap |
| GATEWAY | 2 | 6G | 2 | 1800 | 4.51 GiB + 0.15 GiB swap |
| E2E_BINS | 2 | 6G | 2 | 1800 | 3.80 GiB + 0.50 GiB swap |

The policy and five contract scripts pin all 24 CPU, memory, jobs and timeout defaults and the five direct driver calls. Against the parent policy, the seven edited driver and policy contract invocations fail at their default pins (`dev/v0109-team/evidence/Hygiene109/sibmsr/defaults/red-first.launch.{log,status}` and `red-first/` in the private guest). The paths below are under `dev/v0109-team/evidence/Hygiene109/sibmsr/defaults/`. On the proposed policy, `make sdme-policy-contract-check` and `make sdme-contract-check` exit 0 (`precommit-v2.launch.{log,status}` and `precommit-v2/` in the private guest). Each of 24 single-value mutations makes its own driver contract and the policy contract fail while the other five driver contracts pass (`mutants.launch.{log,status}` and `mutants/` in the private guest). The first combined contract attempt exits 2 on an incorrect Nix test expectation that `max-jobs` equals 2; the driver's Nix configuration fixes `max-jobs = 1` and sets `cores = 2`, and the corrected contract passes (`precommit.launch.{log,status}`, `precommit-v2.launch.{log,status}`). With the row included in the private guest, `make sdme-contract-check`, `make sdme-policy-contract-check`, `make shell-check` and `make workflow-check` each exit 0 (`pre-gate.launch.{log,status}` and `pre-gate/` in the private guest). The committed gate repeats those four commands and checks the source clean after them; its logs and statuses are under `dev/v0109-team/evidence/Hygiene109/sibmsr/defaults/commit-gate-v2/`. The first committed wrapper, `commit-gate/`, exits 127 after the four commands because `timeout` cannot run its shell function `check_source_clean`; it is kept beside the corrected run.

The kept one-CPU patch is landed at `7d797a6cb` and the rustup fixture patch at `8988cd38b`, with their tests and review recorded in Contract gap repaired 2026-10-21. This build covers acceptance 1 (six measured driver passes and the separate failed COPR prerequisite attempt), acceptance 2 (the six measured defaults and their red and green contract pins), and acceptance 3 (both kept patches landed with their record).
