# The release workflow's Linux deps step times out on a crawling apt mirror before its fallback runs

Status: accepted for v0.113.0 by the owner's word of 2026-10-27; implemented on `v0113/c-aptcrl`, with local proof green and Actions acceptance pending.

## What was seen

The v0.112.0 Release dry run 40424605751 on `0.112.0-ga` (2026-10-27) failed twice in its `linux validation` job at the step `Install Linux Tauri and Windows cross-check build deps`: `The action ... has timed out after 15 minutes`. apt fetched from `azure.archive.ubuntu.com` at about 60 KB/s (the 35.4 MB `gcc-mingw-w64-x86-64-posix` unfinished after six minutes) and no build or test step ran; the third attempt passed. The same signature ended v0.103.0's tagged run on 2026-10-07. The step's comment in `.github/workflows/release.yml` describes the armour: fetch retries and timeouts, and a fallback that drops the azure mirror and retries against `archive.ubuntu.com` when `install_deps` fails. A slow fetch never fails, so the fallback never runs; the step's `timeout-minutes: 15` ends the job first. A red of this kind on a tagged run holds `publish-release` until a rerun.

## Desired contract

A crawling mirror costs the job a bounded wait and then the fallback, not the job: the first `install_deps` is bounded inside the step well under the step deadline, its expiry is treated as a failure that takes the fallback branch, and the step deadline still bounds the whole.

## What to do

1. `.github/workflows/release.yml`, the two steps that carry the `apt_fetch` and `install_deps` pattern with the `apt-mirrors.txt` fallback (`Install Linux Tauri and Windows cross-check build deps` in the Linux validation job and `Install Linux Tauri build deps` in the Linux desktop packages job, the one v0.103.0's tagged run met): run the first `install_deps` under `timeout` with a bound that leaves room for the fallback inside the step's deadline, and fall through to the fallback on its expiry.
2. `make workflow-check` green; a dispatch of the changed workflow with publishing off green.

## Acceptance

1. A constructed slow first attempt (a `timeout` far below the real fetch time in a scratch dispatch) takes the fallback branch and the step completes.
2. `make workflow-check` green.

## Build decisions (2026-10-27)

- Both dependency steps bound the first package-index update plus `apt-get install --download-only` to five minutes, with `--kill-after=30s`. The original 15-minute step deadline still bounds the fallback and installation. A timeout or fast failure removes the Azure mirror using the existing mirror-file and source-list edits, updates again and downloads once more, then installs with `--no-download` from the local cache.
- The timed child runs `bash -c` with the `apt_fetch` and `install_deps` definitions passed by `declare -f`; `timeout` cannot invoke a shell function itself, and exported functions would be filtered by sudo. An outer `sudo bash -e` runs the step as root, so the timeout monitor and apt share privileges without an inner sudo moving apt into a separate terminal session. A TERM trap keeps the timed shell waiting until its foreground apt exits; otherwise the shell can exit first and disarm `--kill-after` while a TERM-resistant child still holds apt's lock. `update && install_deps --download-only` propagates an update failure instead of relying on errexit inside a conditional.
- The bounded attempt never invokes dpkg unpack/configure: [`--download-only`](https://manpages.ubuntu.com/manpages/noble/man8/apt-get.8.html) fetches archives without installing them. The final `--no-download` install cannot re-enter a crawling network fetch. No dpkg recovery is needed for this timeout path; the overall step deadline remains the last-resort bound.

### Timing evidence

Read-only `gh run view` and the Actions jobs API supplied these dependency-step durations in seconds. The desktop columns name the matrix architecture; they measure the entire existing update/download/install step, not downloads alone.

| Release run | Validation | amd64 | arm64 |
| --- | ---: | ---: | ---: |
| [v0.110.0](https://github.com/fiorix/chan/actions/runs/40198951244) | 51 | 29 | 36 |
| [0.111.0-rc1](https://github.com/fiorix/chan/actions/runs/40257053345) | 52 | 34 | 54 |
| [0.111.0-ga](https://github.com/fiorix/chan/actions/runs/40279764630) | 31 | 43 | 44 |
| [v0.111.0](https://github.com/fiorix/chan/actions/runs/40287915364) | 31 | 26 | 49 |
| [0.112.0-ga, attempt 3](https://github.com/fiorix/chan/actions/runs/40424605751/attempts/3) | 49 | 23 | 65 |
| [v0.112.0](https://github.com/fiorix/chan/actions/runs/40435950118) | 36 | 331 | 46 |

The [first failed validation attempt](https://github.com/fiorix/chan/actions/runs/40424605751/job/121927191863) ran from 00:21:37Z to 00:36:50Z (913 seconds); the [second](https://github.com/fiorix/chan/actions/runs/40424605751/job/121942251686) ran from 00:53:50Z to 01:09:03Z (913 seconds). Both were stopped by the 15-minute Actions timeout. The first log downloaded the index in one second, requested 179 MB of archives, and was still fetching the 35.4 MB `gcc-mingw-w64-x86-64-posix` archive when the job was killed. The [331-second green desktop step](https://github.com/fiorix/chan/actions/runs/40435950118/job/121964585593) spent 313 seconds downloading 64.1 MB at 204 kB/s, confirming that its outlier was also a crawling download.

Five minutes gives ordinary successful steps (23-65 seconds in this sample) substantial headroom while deliberately switching away from a crawl like the 331-second outlier. Including the 30-second TERM-to-KILL grace, the fallback retains 570 seconds, 239 seconds more than the slowest complete green step observed. This is a measured budget, not a guarantee that a second slow or unavailable mirror can succeed; the 15-minute step still fails closed in that case.

### Local proof

The scratch harness extracts both `run:` bodies from the workflow, substitutes only the apt configuration path and a scaled timeout (0.8 seconds plus a 0.2-second kill grace within a 3-second step deadline), and stubs `apt-get`, `sudo` and the GNU `sed` edits. It invokes the real GNU timeout and Bash. Both original bodies from `e03537239` fail the crawling-mirror control at the step deadline with status 124 and no fallback, proving the harness detects the defect.

Both changed bodies pass eight cases each: a healthy first download (no fallback); a crawling download; a fast download failure; a TERM-resistant download holding an advisory apt lock; a failed index update; a crawling index update; a fallback download failure (status 100, no install); and an install lasting longer than the download bound (completes without interruption). Assertions check the exact package lists, all four mirror/source edits, operation counts, warning, successful cache download before installation, and the 3-second overall deadline. Successful crawl cases complete in 1.12-1.16 seconds; TERM-resistant cases in 1.34-1.36 seconds. The initial implementation without the TERM trap failed the lock test because the timed shell exited before its child; the trap fixes that observed failure.

`make workflow-check` passes (actionlint and shellcheck); `make shell-check` passes (95 tracked scripts plus the storage contract). Direct shellcheck of each root-shell heredoc also passes, covering the shell nested inside `sudo bash`. The harness remains scratch evidence rather than adding a permanent test framework for two workflow blocks.

The constructed slow Actions dispatch and the complete `publish=false` dispatch remain pending the owner's explicit authorization. Local simulation does not substitute for these acceptance runs.

### Delivery and deferred checks (2026-10-27)

The implementation is commit `991e30890`. Its committed-state rerun passed `make workflow-check`, `make shell-check`, and all 16 harness cases; both original-code crawling controls failed as expected. A full pre-push gate first stopped for insufficient disk space. After the owner freed space, the retry passed the static checks, formatting, clippy and rustdoc, and was running the Rust tests when the owner said, "no need to run full gate, we will do this later", followed by "if you completed your work just commit and push to your branch". The running gate was stopped and delivery proceeds with the full gate explicitly deferred. The incomplete test run is not reported as a pass.

The scratch branch for the constructed slow-attempt proof is prepared locally at `8ca00682b`; only the two first-attempt timeouts differ, at one second. Neither the scratch branch nor either acceptance dispatch has been sent to GitHub. Those acceptance proofs remain outstanding; the owner's final instruction requests committing and pushing the implementation branch. The merge/release owner must run the full gate and the two `publish=false` dispatches before claiming the row's complete acceptance.
