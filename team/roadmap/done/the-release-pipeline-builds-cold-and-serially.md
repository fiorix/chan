# The release pipeline builds cold and serially

Status: SHIPPED in [v0.96.0](../../release/release-v0.96.0.md) with acceptance 3 partly met and acceptance 4 not yet observable. Landed from `ci/pipeline-speedup` (`3e9c19c1`, `81c0c922`, `26e67783`, `aa1dca8c`), fast-forwarded so the four commits land verbatim. Acceptance 1 was verified independently on Release run `32636504451`: every build job started within five seconds of `release context`, against the item's claimed ten. Acceptance 3 holds for the model bundle and not in full: `crates/chan-server/build.rs` still emits `rerun-if-changed` unconditionally for the two frontend build stamps, so a second `cargo build` is a no-op only on a tree whose frontend was built through the Makefile. Acceptance 4, the warm-cache observation, cannot be made until the first `main` CI run after this GA, by construction.

## Problem

A GA cut spends about four hours in the pipeline: a `release.yml` dry run of 60 to 66 minutes, a second full `ci.yml` run of 36 to 55 minutes for a re-cut of the GA commit whose only change is the report text, a tagged `release.yml` run of 60 to 66 minutes, and about an hour of `publish-downstream` that is COPR-bound by design. At 1.2 tags per day this is the dominant cost of releasing, and the two timestamped GA journals (v0.80.0, v0.95.0) show the owner or the agent waiting on those serial stages for most of a cut.

Inside the runs, four things are wrong, none of them the work the jobs exist to do:

- Every `release.yml` job restores no Rust cache. The repository holds 11.5 GB of Actions caches against the 10 GB cap; each `X.Y.Z-ga` branch dry run writes about 10 GB of per-job entries, which evicts `main`'s, and a tag run can read only `main`'s. The same `make ci-linux` takes 43 minutes cold and 26 warm; `main`'s own CI alternates between 35 and 54 minutes for the same reason.
- The Linux and macOS artifact jobs wait for validation jobs that duplicate the `ci.yml` arms on the same commit, so the run's wall-clock is validate plus artifacts instead of the slowest single chain. The macOS chain was the long pole in 40 of 64 green tag runs.
- The two validation jobs compile `tauri-cli` from source (five to six minutes each) because they lack the prebuilt-install step the other jobs have, and `macos-validate` links against an older Xcode than the desktop package it validates.
- `crates/chan-server/build.rs` emits a `rerun-if-changed` for a model bundle that does not exist on any CI checkout, which Cargo treats as stale on every invocation, so every cargo call in a job recompiled `chan-server` and every crate above it; the `chan` and `chan-desktop` build-id scripts refreshed `.git/index` with `git status`, which they also watch, with the same effect on `chan`. `make ci-windows` compiled `chan` in release twice, 9.6 and 8.6 minutes, and `chan-server` four times in one job.

## Desired contract

- A release branch or tag run restores the dependency cache `main`'s CI wrote; no branch run evicts it. The cache writers are the three `make ci-*` jobs on `main`, keyed per OS and architecture and shared with `release.yml` and the desktop dry run.
- Every `release.yml` build job starts from `release context`; `publish-release` waits for validation and artifacts alike, so publication is still gated on validation while wall-clock is the slowest single chain.
- The validation jobs use the prebuilt `tauri-cli` and the same Xcode as the artifact jobs.
- A second cargo invocation in an unchanged tree compiles nothing: the build scripts watch only inputs that exist and do not move the inputs they watch.
- The GA commit is not re-cut for run ids; the ids are recorded after the tag (after the COPR freeze) or resolved by `gh run list --commit <sha>`.

## Boundaries

The publication contract is unchanged: the same artifacts, the same proofs, the same downstream lanes and retries. No paid runners. The Windows release job's explicit `cargo build --release -p chan-desktop` before `cargo tauri build` (rebuilt anyway by the tauri build's feature resolution) is a signing-flow decision left as a follow-up; the Docker dependency layer, the AUR CI caches, and a lighter CI profile are out of scope.

## Acceptance

1. On a `release.yml publish=false` dispatch, every build job starts within seconds of `release context`; `publish-release` lists both validate jobs in its needs.
2. No `installing tauri-cli` line in either validate job's log; `macos-validate` prints the same Xcode and SDK as `macos-desktop-artifacts`.
3. `make ci-windows` shows one release compile of `chan`; `cargo build -p chan-server` run twice compiles nothing the second time.
4. After the change is on `main` for one CI run, the next dry run's root-workspace jobs log `Cache hit for: v0-rust-rust-<OS>-<ARCH>-...`, and `gh api repos/fiorix/chan/actions/cache/usage` stays under the cap across a full cycle.
5. The GA sequence in `.agents/skills/release/SKILL.md` contains no re-cut.

## Acceptance 3, as measured

Acceptance 3 is met for the model bundle and not yet met in full. Measured in the round container at `9f8a7faf` with `resources/models.tar.zst` absent: two consecutive `cargo build -p chan-server` invocations both compiled `chan-server`, and `CARGO_LOG=cargo::core::compiler::fingerprint=info` named the cause as `the file crates/chan-server/../../web/.chan-build-stamp is missing`. The model-bundle guard works and is no longer the reason; `web/.chan-build-stamp` and `web-launcher/.chan-build-stamp` are still emitted unconditionally by a deliberate pre-existing choice not to write a placeholder into the source tree. A tree whose frontend was built through the Makefile carries both stamps and does see the no-op, which is the case on CI and why the measured `make ci-linux` improvement from 38.0 to 30.8 minutes is real; a gate worktree that has never built the frontend still relinks. Closing the remaining half is a follow-up, not a regression.

## Evidence

- The 8.5-week run sweep and the per-phase log timings behind each number are in the round setup's `dev/v096/pipeline-review.md`.
- Branch dispatches, all green and all cold: Release dry runs `32628489168` (52 min, from 59.5; every build job started within 10 s of `context`), `32633879594` (49 min), `32636504451`; CI runs `32628488224` (54 min), `32631066802` (53 min), `32633878695` (49 min), `32636503263` (`make ci-windows` 33.7 min, from 54.2 on the first branch run). `make ci-linux` 38.0 to 30.8 min and `make ci-macos` 34.5 to 27.9 min between the first and third CI run.
- The build-script fix was proven both ways in the integration container, on a tree whose frontend had been built through the Makefile so both build stamps were present: with the old script a second `cargo build -p chan-server` recompiles `chan-server`; with the new one it compiles nothing (`Finished` in 0.72 s). On a tree without those stamps the second build still recompiles, for the separate reason recorded above.
