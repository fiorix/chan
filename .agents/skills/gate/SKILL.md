---
name: gate
description: >-
  Run the chan pre-push gate (shellcheck, actionlint, fmt, clippy, test,
  no-default-features build, gateway build, web checks, release devserver
  smoke, native desktop package) and the isolated/own-gate model for
  multi-agent rounds.
when_to_use: >-
  Before any push, when CI fails, or when you need to validate a
  change against the same checks CI runs.
---

# The pre-push gate

`scripts/pre-push` is the git hook; it `cd`s to the repo root and runs `make pre-push`, teeing the output to `target/pre-push.log` so a red gate stays diagnosable after the push. Keeping the target list in the Makefile keeps the local hook and CI from drifting. Install the hook with `./scripts/install-hooks`.

## What `make pre-push` runs

The gate runs, in order:

1. `make shell-check` (shellcheck over every tracked shell script)
2. `make workflow-check` (actionlint over `.github/workflows`, with shellcheck on the `run:` blocks)
3. `make build-matrix-check` (the static contract tying native CI, distro, and container jobs to their real build targets)
4. `make nix-sdme-contract-check` (the sdme Nix driver exercised against a stub, without starting a guest). **Linux only**, like every gateway step below: the driver calls GNU coreutils and the gateway builds inside an sdme container, so neither means anything on a macOS or Windows host and `pre-push` skips the pair there. Those targets refuse outright if invoked directly, naming `make ci-macos` / `make ci-windows` instead. The Linux arm's coverage is unchanged, and it is the arm the release gate runs on
5. `make web-lock-check` (strict `npm ci --dry-run`; rejects a desynced `web/package-lock.json` that every other web target's `npm install` would silently repair in place). It enforces npm >= 10, because older npm removes `node_modules` under `--dry-run`. The `chan-ann-ubuntu` build rootfs ships npm 9.2.0, so a container built from it fails this step until npm is raised in the guest; the step says so with the resolved version rather than failing obscurely.
6. `cargo fmt --check` for the root workspace, and `make gateway-fmt` for the separate gateway workspace (Linux only; see step 4)
7. `cargo clippy --all-targets -- -D warnings` (with `RUSTFLAGS=-D warnings`)
8. `cargo test --all-targets` (with `RUSTFLAGS=-D warnings`)
9. `cargo build --no-default-features` (with `RUSTFLAGS=-D warnings`)
10. `make gateway-lint` (clippy over the SEPARATE gateway workspace, warnings denied; the root clippy run does not reach it)
11. `make gateway-build` (the SEPARATE gateway Cargo workspace; builds its SPA then its release crates)
12. `make web-check` (svelte-check + vitest + production build)
13. `make web-marketing-check` (marketing site build + smokes)
14. `make shortcuts-check`
15. `make host-build-check` (release CLI build plus a foreground-devserver health smoke, followed by a native AppImage on Linux or an ad-hoc-signed `.app` on macOS)

Steps 1 and 2 lint `packaging/`, `scripts/`, and the workflows; step 3 additionally proves that every shipped build surface still has an automatic native, distro, or container build edge.

The sdme in step 4 is the project's systemd-nspawn container manager, a third-party tool (installed from sdme.io) that drives the disposable local builds: the containerized Nix recipes, `make windows-cross-check`, the COPR matrix builds, and the Linux desktop bundles. It is local-dev tooling; CI never uses it. The contract check runs only the driver script against a stub and never starts a container; the real containerized Nix build (`make nix-sdme-check`, the release-time hash-harvesting tool) is deliberately NOT part of `pre-push`. `scripts/lint-static.sh` fetches both linters at a pinned version, each verified against a checksum, into `${XDG_CACHE_HOME:-~/.cache}/chan/lint-tools` (override with `CHAN_LINT_TOOLS_DIR`). The cache is deliberately outside `target/`, which the gate discipline wipes: a per-worktree cache under `target/` would mean a fresh download for every isolated or GA gate. Only a cold cache needs network. The severity and the exclude list, with the reason for each exclude, live in `.shellcheckrc`.

`make pre-push` is host-native, not a cross-platform gate. The release gate runs on Linux, so it cannot see Windows or macOS breakage. `make windows-cross-check` deliberately remains outside `pre-push` and is a mandatory release-checklist step; it compiles and lints the CLI crate graph for Windows GNU inside a disposable sdme container (so it needs sdme and an imported Ubuntu rootfs on the host) but does not link or smoke a Windows binary. The mandatory `release.yml` dry run supplies the macOS compile. Neither release check changes the per-push gate.

The gateway is a separate Cargo workspace and is NOT a member of the root workspace. A `crates/`-scoped check misses it, plus the `chan-desktop` (`desktop/src-tauri`) construction sites. When a change touches a cross-workspace struct, build the whole repo, not just the default workspace.

## The browser smokes are outside the gate, deliberately

`scripts/e2e/browser-smoke` is not in `make pre-push`, is not in CI, and is not absent by accident. It stays out for three reasons, and each one names what would have to change:

- **It has not graduated.** `scripts/e2e/README.md` admits a suite to the gate only once it has proven stable across several sessions on more than one host. This one runs on one host, and until its page loads stopped waiting on `networkidle2` its external-edit matrix failed two runs in three under load. Ten consecutive green runs on a loaded host is the evidence for one host, not for the rule.
- **No runner carries what it needs.** Chrome and the libraries it links against are about 400 MB that neither a CI runner nor a build container has by default. `make browser-smoke-deps` installs them per container in seconds of work but hundreds of megabytes of disk, and wiring the suite into `pre-push` would put that on every contributor's push.
- **It costs a build and a server.** The suite builds the web bundle and a debug binary, launches a real `chan open`, and drives a real browser through every check. Forty-two checks took twelve minutes on a contended eight-core host with the build already done, against a gate whose other steps are seconds. That is the shape of thing that gets disabled rather than fixed once it slows a push down.

Run it by judgment after a session that touched the editor, the terminal, the launcher, or anything the SPA renders, exactly as the other `scripts/e2e/` suites are run. `make browser-smoke-deps` first in a fresh container, then `node scripts/e2e/browser-smoke/run.mjs`. It exits 2, not 1, when the environment cannot run it, so a caller can tell a missing browser from a real failure; treat that 2 as work to do, never as a pass.

The editor's external-edit convergence path is the part this covers that nothing else does, and it is the part that keeps needing hardening. A change to `flushed_mtime_ns` or the doc-session reconciler is the clearest case for running the suite before pushing, gate or no gate.

## Discipline

- **Re-run after the last edit.** A check that ran before a later edit is stale. `cargo fmt --check` and `make gateway-fmt` in particular must run AFTER the final edit, or an "own-gate-green" report is wrong.
- **Don't pipe the command you are verifying.** `cargo ... | tail` reports tail's exit 0 and hides cargo's failure. Run bare and check `$?`, or set `pipefail`. `${PIPESTATUS[0]}` looks like the fix and is not a reliable one: it holds only the most recent pipeline, so a `;` and an intervening command between the run and the read leave it empty, which prints as an empty status rather than as an error.

  Knowing this rule does not protect you, because the wrong number arrives somewhere that looks authoritative. A backgrounded or notified run reports **the exit status of the whole pipeline**, so a suite whose output was piped through `grep` or `tail` is announced as "exit code 0" while its own summary line says fifteen failures, and that announcement is the thing a tired reader believes. Treat a reported status as belonging to the last command in the pipeline until proven otherwise, and take the verdict from the artifact the run wrote (`results.json`, a status file, the summary line) rather than from the number attached to the notification. Where a wrapper needs the real status, capture it inside the wrapped shell (`cmd > log 2>&1; echo "rc=$?" > status`) before anything downstream can overwrite it.

  Suppressing output does the same damage one step earlier and further away. A setup step run as `apt-get ... >/dev/null 2>&1` that fails leaves the tool it was installing absent, and what reports the problem is some later probe failing for its own apparent reason, such as a missing `curl` surfacing as `SERVER_DOWN` against a server that was answering HTTP 200 throughout. The lie lands in the diagnostic rather than in the gate, and it points at the wrong subsystem, so the cost is a re-run of something that already worked. Let setup steps fail loudly, and when a probe reports a subsystem down, confirm with a second mechanism that shares none of the first one's dependencies before believing it.

  The same pipe truncates the **output**, and that is a separate failure with a worse consequence than a hidden status. `| tail -40` keeps the end of a run and discards the middle, so on a run that printed failure detail the result lines are what falls outside the window. The loss is not random: a failing or slow run prints more than a clean one, so truncation drops most from exactly the runs that matter, and a harness reading a fixed tail sees a systematically biased sample. That does not only hide reds, it manufactures findings, because a control that "apparently moved" and an anomaly that is really a missing line are indistinguishable downstream. Redirect the whole log to a file and search the file; if you must narrow, grep for the result pattern rather than slicing by position.
- **The gate gates every push, including tags.** A backgrounded gated push can SIGPIPE (exit 141) and silently fail to update the remote. Push in the foreground, redirect to a file, and verify with `git ls-remote`.
- **Prove the instrument can see a failure.** A harness that reads results by pattern-matching a runner's output can miss a red and report it as silent; a classifier that infers from a grep line rather than from the source can misfile working code. Before trusting what a tool tells you about a check, confirm the tool goes red on a known failure.
- **Gate the commit, not the working tree.** A scoped gate that runs on a dirty tree and is committed afterwards has not gated the commit it reports: the tree can move under a long run, and `git diff HEAD --quiet` after the fact proves only that the tree matched at that moment, not throughout. Either commit first and gate the committed state, or hash the tracked content before and after the run and withhold the green if it moved. Printing `HEAD` and a dirt count makes the mismatch visible without closing it.

## Isolated / own-gate model (multi-agent rounds)

In a multi-agent shared worktree, the full-tree `make pre-push` gates the COMMITTED state and is run by a single owner (e.g. the round's lead) from an isolated gate worktree, so it is immune to peers' in-flight working-tree changes.

Worker lanes report a scoped OWN-gate-green **against that commit**, plus the pathspec they committed, and do not block on the main-tree pre-push: a concurrent peer's WIP causes false reds there. The committed-state rule is not the lead's alone: a lane's scoped green names a sha, so it has to have gated that sha rather than the working tree that became it. The scoped own-gate for frontend work must run `make web-check` (vitest included), not just svelte-check plus build, or stale source-pins slip past the scoped check and the integrated gate catches them later.

A lane that touches any shell script (`packaging/`, `scripts/`, `web/packages/marketing/src/install.sh`, a git hook) or any `.github/workflows` file owns `make shell-check` and `make workflow-check` in its scoped own-gate. Both run in seconds and neither is implied by a Rust, frontend, or desktop scoped gate, so without this the linters first fire at the lead's integrated gate, on someone else's clock.

A backgrounded process does not outlive the `sdme exec` that started it, and `setsid nohup cmd &` does not change that: the command returns, the session ends, and the child goes with it. Verified by spawning `setsid nohup sleep 300 &` inside an exec and finding no `sleep` afterwards. Run anything long-lived as the exec's own foreground command and background the *caller* instead, or the run dies silently and its absence looks like a fast failure.

Both linters enumerate their inputs with `git ls-files`, so they need to see the repository, which a container running against a bind-mounted worktree does not by default: a linked worktree's `.git` is a file pointing at the main checkout's `.git/worktrees/<name>`, and that path is not mounted. Bind the main checkout's `.git` at its real path alongside the worktree, and set `git config --global --add safe.directory` for the container's root. Without it `make shell-check` dies with `found no tracked shell scripts to check`, which fails closed and prints git's own `not a git repository` immediately above it, but names the wrong cause.
