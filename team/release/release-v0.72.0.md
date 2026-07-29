# Release v0.72.0 - terminal batching and the Linux distro spread

Round run 2026-07-19 to 2026-07-20 off the v0.71.0 tag. Five roadmap items shipped: one terminal behavior change, two new Linux packaging paths, one new command, and one self-upgrade refusal. Cut straight to GA with no rc cycle, on a `publish=false` dry run, following the v0.70.1 and v0.70.3 precedent. A sixth accepted item, the distributed proxy control plane, was deferred out of this release with no code merged.

## What shipped

- **Terminal write-queue batching.** Consecutive queued `cs terminal write` notifications reconcile into one agent turn at an idle opportunity instead of consuming one full turn each, and `cs terminal list --json` reports each session's `queue_depth` so a script can tell a busy queue from a drained one.
- **CentOS Stream COPR packaging.** The COPR project carries CentOS Stream chroots for `chan` on Stream 9 and 10 and for `chan-desktop` on Stream 10, with `make copr-check` rebuilding, installing, and smoking the vendored RPMs in clean containers.
- **Arch AUR packaging for `chan` and `chan-desktop`.** Source-built recipes that disable self-upgrade in favor of the AUR helper, with the desktop recipe linking against the host WebKitGTK/Mesa stack rather than repackaging the AppImage.
- **`chan dump-skill`.** One command prints an agent-facing manual of chan's whole surface, assembled from the live `--help` of real commands so it cannot go stale against the binary printing it.
- **The packaged self-upgrade refusal covering every personality.** A distro-packaged chan-desktop refuses `chan upgrade` and `chan upgrade --check` up front, with no window, naming the package manager to use; the refusal is decided before the personality is consulted.

## Team / process

Roadmap-driven, integrator plus lanes. The five items ran as named lanes (`lane-t` for the terminal queue, `lane-h` for COPR, `lane-a` for the AUR, `dump-skill`, and `lane-gate` for the shellcheck and actionlint static gates), merged into `main` one at a time with hand reconciliation. The packaged-upgrade refusal landed directly on `main` after the merges. The integrator owned the merges, the acceptance runs, the gate, and this report. Coordination artifacts live in the untracked `dev/` tree of the round host's checkout.

## Validation

All of the below ran on an x86_64 Linux host.

- **Terminal queue-drain live matrix: 18 runs, all green.** Codex and Claude, three cases each (batch, boundaries, late), 3 runs per case, 64 KiB payload, 50 ms gap. Batching is proven by the agent building `QUEUE_DRAIN_BATCH_5` from the number of notification blocks it received, with the polled queue depth going 5 straight to 0 with no intermediate sample. The boundaries case drains one at a time and its traces pass through every one of depths 4, 3, 2 and 1.
- **`make copr-check`: exit 0.** PASS el9 `chan` x86_64, PASS el10 `chan` x86_64, PASS el10 `chan-desktop` x86_64. There is no el9 `chan-desktop` target, which is the intended denylist.
- **`make aur-check`: exit 0**, run against the merged `main` tip. Both packages built, installed, and smoked; namcap reported zero error-class lines (4 warnings for `chan`, 11 for `chan-desktop`, all dependency-declaration noise) with a genuinely empty waiver list.
- **Full `make pre-push` on a fresh target from a detached worktree: exit 0**, all nine steps, 2248 tests passed, 0 failures.

Not proven, and not claimed:

- aarch64 for either packaging path.
- Any build on the COPR service.
- Any AUR publication; both pkgbases are still unclaimed.
- CachyOS specifically.
- Any desktop GUI behavior; the validation containers are headless.
- macOS compile, sign, and notarize beyond the owner's smoke off the dry run.
- Gemini and OpenCode submit timing; neither CLI is installed on the validation host and both need interactive auth.

## Retrospective

### Highlights

- The terminal batching claim is backed by a live oracle rather than a unit test alone: the agent reconstructs the batch size from what it actually received, so a regression that split a batch would change the reported number instead of passing silently.
- Both packaging paths were validated in clean containers on the host before the tag, so the COPR and AUR legs of `distros-publish` go into GA with their recipes already known to build, install, and smoke.

### Lowlights

- Four defects found during the round were in the checks themselves, not the shipped code, and each one made a gate incapable of failing. The queue-drain harness's ANSI strip used a bracket range invalid under a UTF-8 locale, so its scrollback read back empty and its negative oracles could never fail. The AUR container name was built from `uname -m` unnormalized, which sdme rejects on x86_64, so that gate had never run on this architecture. The AUR `chan-desktop` missing-shared-library check used `! grep`, which suppresses errexit, so it could not fail. A `chan open --help` string literal lost its first row's indent to a line-continuation escape that no gate could see, because the checker compared source text rather than the compiled value.
- A devserver test helper's port selection raced under load; it now redraws the port on a bind collision. This mattered beyond CI flakiness because the AUR recipes run the release test suite in `check()`, which `makepkg` runs by default, so the flake could have failed an end user's install.

### Honest feedback

The pattern behind the four defects above is a check that asserts on the wrong artifact: source text instead of the compiled value, an empty buffer instead of scrollback, a suppressed exit code instead of a failure. A green gate that has never been able to go red is worth less than no gate, because it also buys false confidence. The cheap counter is to break the thing on purpose once and confirm the check reddens, which is what surfaced three of the four here.

## Follow-ups

- aarch64 for COPR and for the AUR is unproven anywhere; the AUR recipes declare it and the COPR matrix is configured for it, but no build has run.
- Both AUR pkgbases are unclaimed, so the first GA publish is also the first push to a new repository.
- Gemini and OpenCode queue-drain timing needs a host with those CLIs installed and authenticated to run the same three cases.
- The distributed proxy control plane moves to [v0.73.0](../roadmap/done/distributed-proxy-control-plane.md).
