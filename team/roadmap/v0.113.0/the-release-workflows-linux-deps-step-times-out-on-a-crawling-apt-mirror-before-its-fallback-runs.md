# The release workflow's Linux deps step times out on a crawling apt mirror before its fallback runs

Status: raised on 2026-10-27 by the lead at the v0.112.0 GA; accepted for v0.113.0 by the owner's word.

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
