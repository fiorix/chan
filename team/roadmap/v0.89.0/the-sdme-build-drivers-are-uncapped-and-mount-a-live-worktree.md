# The sdme build drivers create uncapped containers, and three of them mount the live worktree

Status: REGISTERED 2026-08-11, merged from three v0.88.0 drafts on the owner's ruling that they are one lane rather than three: the Nix driver's missing disk cap, the live worktree bind the other drivers carry, and the six discarded writes in `crates/chan-server/build.rs`. The owner also ruled the source draft's writable-snapshot design out of scope, on the ground that the repository already contains the arrangement it proposed to invent. A second owner ruling on 2026-08-11 widened the storage half of this item into a standing project rule: **every sdme container this repository creates uses the btrfs backend, and overlay is never used here.** That converts `--storage btrfs` from a means of making `--disk` effective into a requirement in its own right, and it reaches every container-creating invocation in the tree rather than the build drivers alone, which the boundaries below now reflect. Promoting the cap half settles a debt in shipped history: [`release-dry-run-does-not-predict-the-tagged-run`](../done/release-dry-run-does-not-predict-the-tagged-run.md) says at its line 104 that this finding was "Registered for v0.89.0 instead", and until this file existed the repository asserted a registration it had not made.

## Why one item and not three

The three sections below separate as prose, not as work. The cap and the source mount are arguments to the same `sdme new` call, one line apart, in the four drivers that bind a source; the fifth, `packaging/sdme/build-chan-desktop.sh:91`, creates its container with `sdme create` and no bind at all, and seeds it through `sdme cp` at `:103`. The build writes and the source mount are the same change arriving from opposite directions, which section 3 states in full: a source tree the build cannot write to is what makes a discarded write expensive, and a discarded write is what makes a read-only source undiagnosable.

## 1. No container-creating invocation names a backend, so every one of them runs on overlay, and a disk flag alone would be inert

`packaging/nix/build-with-sdme.sh:205-209` creates its disposable build container with neither a storage backend nor a disk cap:

```sh
"${SDME_CMD[@]}" new --name "$CONTAINER" -r "$NIX_SDME_ROOTFS" -t 180 \
    -b "$SOURCE_SNAPSHOT:/src:ro" -b "$OUT:/out" \
    -- /usr/bin/env ...
```

The two flags are coupled. From `sdme new --help` on the installed sdme 0.18.0:

```
--disk <DISK>        Disk cap for the container root, btrfs storage only (e.g. 200M, 2G)
--storage <BACKEND>  Storage backend for the container root: overlay, btrfs, or auto
                     (default: auto)
```

Its own usage example pairs them: `sdme new --name build -r ubuntu --storage btrfs --disk 4G`. So `--disk` alone is not a weaker cap, it is no cap at all: the flag applies only to the btrfs backend, and `auto` resolved to overlay in every observation on the owner's host. An overlay container carries no `btrfs qgroup` entry, so it is invisible to the accounting every other container on the shared pool is measured by, and `sdme ps` prints `-` in its DISK column, which does not read as an error.

`sdme create --help` on the same 0.18.0 lists `--disk` and `--storage` with the same text, so the one driver that creates its container with `sdme create` rather than `sdme new`, `packaging/sdme/build-chan-desktop.sh:91`, takes the same pair. Its `cap: none` row below is a flag nobody passed, not a flag the subcommand lacks.

The omission is not confined to the Nix driver. A grep for `--disk` and `--storage` over the tracked tree returns no hit in any script, Makefile or workflow; the only occurrences anywhere are the prose at `team/roadmap/done/release-dry-run-does-not-predict-the-tagged-run.md:108-111` and `:130`.

Counted at `f9c2878c`, the tracked tree carries ten container-creating invocations and not one of them names a backend: the five build drivers tabled below, plus `packaging/gateway/scripts/dev/sdme/build-gateway.sh:90`, `packaging/gateway/scripts/dev/sdme/devserver-tunnel-e2e/build-bins.sh:37`, `packaging/gateway/scripts/dev/sdme/devserver-tunnel-e2e/run.sh:115` and `packaging/gateway/scripts/dev/sdme/devserver-tunnel-e2e/zone-isolation-probe.sh:27` in the gateway tree, and the documented `sudo sdme create` in the header of `packaging/sdme/chan-devserver.sdme:17`. Three further `sdme create` lines in `docs/contributing/linux-and-macos.md`, at `:50`, `:154` and `:247`, teach a contributor the uncapped overlay form as the way to make a container. The seven `.sdme` files are not part of this population and need no change: they are rootfs build definitions consumed by `sdme fs build`, so the backend is not theirs to name.

The repair is an explicit `--storage btrfs` on each of those ten invocations. **sdme's own default is not to be changed**, by owner ruling: `/etc/sdme.conf` is host state shared with everything else that uses sdme on that machine, so a repository rule enforced by mutating it would silently reach containers this project does not own, and would leave chan's drivers reading correct only on a host somebody had configured. Each invocation names the backend it requires, and the guard reads the invocations rather than the host.

| driver                                     | line | source           | cap  |
| ------------------------------------------ | ---- | ---------------- | ---- |
| packaging/nix/build-with-sdme.sh            |  205 | tracked snapshot | none |
| packaging/sdme/build-chan-desktop.sh        |   91 | git archive HEAD | none |
| scripts/windows-cross-check.sh              |   71 | LIVE worktree    | none |
| packaging/distros/arch/build-with-sdme.sh   |   59 | LIVE worktree    | none |
| packaging/distros/copr/build-with-sdme.sh   |  227 | LIVE worktree    | none |

Four further container-creating invocations live under `packaging/gateway/scripts/dev/sdme/` and are equally uncapped. They build the separate gateway workspace and its end-to-end rigs rather than chan from this tree; see Boundaries.

### What the containers cost, and the figure that is missing

Measured on the owner's host during real `NIX_PACKAGE=chan-desktop` runs, on a 96G pool with three other build containers active: 22G on one run, and 23G as the maximum over roughly seventy 30s samples on a second run instrumented for it. Both are compressed on-disk size, since the pool is mounted `compress=zstd:3` and host `du` reports allocated blocks; reasoning from `du` inside a container instead reports the logical size, which ran about 2.4x higher on build artifacts in the same measurements.

**Neither run observed the release-profile LTO link**, across two deliberate attempts, so the honest figure is at least 23G with the true maximum unobserved. In the second run the rlib count sat at 539 for about fifteen minutes, and the link, install, output smoke and teardown then all fell inside a window no 30s sample landed in. Do not size a cap from 22G or 23G. Whoever picks N should sample faster than the link or instrument the derivation rather than watching the container from outside, because the failure mode of an undersized cap is a broken release check.

For scale against a number that was actually tried: the round's gate containers were capped at 24G, and 24G was not enough for `cargo test --all-targets` to link. They were raised to 44G to finish. A cap set at the observed 23G would sit below a value already known to be too small for a smaller build, which is why the peak has to be measured rather than extrapolated.

### The cost already paid, stated at the strength the evidence supports

A gate container reached its 24G quota mid-link twice in one round. The first time it presented as a linker `SIGBUS` with a core dump, which reads as a toolchain crash and is not one; the second time it named itself as `Disk quota exceeded (os error 122)`. That instance was a container hitting its own cap, not the Nix driver exhausting the pool, and this item does not claim otherwise. What it establishes is the presentation: a disk limit reached during a link arrives as a compiler bug. An uncapped container consuming the same shared pool while carrying no qgroup entry is how that presentation reaches a lane that did nothing wrong and has no accounting to check.

### What `make nix-sdme-check` actually is

The draft this section came from called it the GA release-verification path. That overstates it, and the correction matters because the stake is what decided against fixing it mid-round. [`.agents/skills/gate/SKILL.md`](../../../.agents/skills/gate/SKILL.md) says at line 39 that sdme is local-dev tooling CI never uses, and that the real containerized Nix build, `make nix-sdme-check`, is deliberately not part of `pre-push`; it is the release-time tool for harvesting Nix fixed-output hashes on a host without Nix ([`.agents/skills/release/SKILL.md`](../../../.agents/skills/release/SKILL.md):70-81). Line 81 of that skill says native `make nix-check`, GA CI and the Cachix publication jobs remain authoritative for release validation and publication.

The stake is still real and still asymmetric: a hash missed at pin time cannot be repaired for that release afterwards (`.agents/skills/release/SKILL.md:58`, with v0.81.0 named as the case that shipped without Cachix pins). But it lands at the version-pin commit, before the tag, not at the tag. What is in the gate is only `make nix-sdme-contract-check`, which drives the driver against a stub and never starts a container (`.agents/skills/gate/SKILL.md:24`, `Makefile:245`).

## 2. Three drivers bind the live worktree, and a fourth binds it writable into a root container

`:ro` stops the container writing to the mount. It does nothing to stop the person at the keyboard writing, and every edit lands under the running build immediately, because the mount is the live directory rather than a copy of it. A build that compiles a mixture of two trees reports a verdict belonging to neither, with a clean exit code and nothing in the log to show it. The window is exactly the period somebody is most likely to fill with editing: while a long gate runs.

**The source draft's inventory was wrong and is corrected here.** It said the repository contains two sdme drivers, one live and one immune. It contains five drivers that build chan from this tree, split three live to two immune, as tabled above. Two of the three live ones also read the script they execute from the same live mount: `packaging/distros/arch/build-with-sdme.sh:64` runs `bash /src/packaging/distros/arch/build-in-container.sh`, and `packaging/distros/copr/build-with-sdme.sh:188` runs `/bin/bash /src/packaging/distros/copr/build-in-container.sh`.

The worst case sits one step earlier in the COPR path and is not an sdme container at all. `packaging/distros/copr/build-with-sdme.sh:173` calls `build-srpm.sh`, and `packaging/distros/copr/build-srpm.sh:62` runs `docker run --rm -v "$REPO:/src"` on a Fedora image, binding the whole worktree **writable** into a container running as root. Line 68 chowns back only `/src/target/distros`, so anything the SRPM stage writes elsewhere in the tree stays root-owned on the host. That is a live worktree, writable, as root, on the path `make copr-check` takes before its sdme matrix starts.

### The immune pattern already exists, twice, and the ask is to adopt it rather than design one

- `packaging/nix/build-with-sdme.sh:133-149` archives the working-tree content of tracked files through `git ls-files -z --cached | tar` into a fresh `/var/tmp/chan-nix-source.XXXXXX` and mounts that. It guards with a work-tree check at `:123-126`, a submodule refusal at `:127-131`, and a snapshot-versus-output overlap check at `:135-138`. Once the tar completes, nothing done to the worktree reaches the run. This is the arrangement [`sdme-ubuntu-nix-build`](../done/sdme-ubuntu-nix-build.md) shipped in v0.84.0.
- `packaging/sdme/build-chan-desktop.sh:99-105` writes `git archive HEAD` to a tar, copies it into the container with `sdme cp`, extracts it to `/root/chan`, and builds there at `:110-115`. The tree lives inside the container's own root rather than on a host bind, so it is writable, immune to host edits, and leaves no root-owned host residue when the container is removed. That property comes from the tree being container-local, not from which backend carries it, so the pattern survives the move to btrfs unchanged.

The second one decides the largest open question in the source draft. That draft argued at length that a read-only source cannot build `chan-desktop` at all, correctly: `desktop/src-tauri/build.rs:6` calls `tauri_build::build()`, which generates into `src-tauri/gen/` during the build, and `:2-4` runs `stage_check_sidecar()` on every non-release profile, which is the `cargo check` and `cargo test` path a gate uses. From that it proposed a host-side writable snapshot, and budgeted root-capable teardown against multi-gigabyte root-owned trees accumulating in `/var/tmp` per run. The repository already builds `chan-desktop` in a container from a seeded tree, in a form that never incurs that cost. **That half of the draft is dropped.** What remains is to adopt the existing pattern or to write down why a second arrangement is needed.

One real difference between the two seeds is worth making explicit rather than discovering: `git ls-files --cached | tar` carries working-tree content of tracked files, while `git archive HEAD` carries committed content only. They answer different questions about what a verdict is about.

### The only compensating control today does not survive round close

A grep of `team/`, `.agents/` and `docs/` finds no mention of the mid-run edit hazard anywhere. The rule that nobody edits a worktree a gate is reading exists only in the round's gitignored coordination tree, and it evaporates when that tree is archived. The same tree is where `scripts/windows-cross-check.sh` is named as the canonical driver to copy from, which is why its live bind was inherited rather than chosen; the phrase "canonical driver" appears nowhere in the checked-in tree. Two lanes independently hand-rolled in-container copies to get insulation, and neither is inheritable: `git grep '/work/chan'` over `scripts/`, `packaging/` and `desktop/` is empty.

The hazard was observed rather than hypothesised. A gate reported green while the worktree it was reading was edited mid-run. That instance was harmless, the edit was Markdown outside any compiled path and the full diff was verified empty afterwards, but nothing about the mechanism made it harmless: a `.rs`, `Cargo.toml` or `flake.nix` edit in the same window reaches the verdict. That observation lives in the round's coordination tree and is not re-derivable from the checked-in tree, which is itself the reason to record it here.

## 3. Six build writes are discarded, and two of them decide whether the build runs

`crates/chan-server/build.rs` writes into its own source tree six times and discards the result every time. Five of the six targets are gitignored (`.gitignore:29`, `:30`, `:32`, `:33`, `:44`), so a tracked snapshot excludes them by construction; the sixth is the model bundle's parent directory, which survives because `crates/chan-server/resources/.gitkeep` is tracked.

| line | write                          | on a source tree it cannot write |
| ---- | ------------------------------ | -------------------------------- |
|   23 | create_dir_all web/dist        | fails, rust-embed then errors    |
|   35 | create_dir_all web-launcher/.. | fails, rust-embed then errors    |
|   44 | write web/.chan-build-stamp    | fails, relink freshness only     |
|   53 | write web-launcher stamp       | fails, relink freshness only     |
|   71 | create_dir_all resources/      | succeeds, .gitkeep is tracked    |
|   74 | write resources/models.tar.zst | fails, only embed-model reads it |

**Lead with `:23` and `:35`.** They are the two that run in every build and decide whether it compiles: `crates/chan-server/src/static_assets.rs:29` and `:39` are `#[folder = "../../web/dist/"]` and `#[folder = "../../web-launcher/dist/"]`, and `build.rs:13-17` and `:30-31` record that rust-embed errors on a missing folder, which is why the directories are created at all. On a tree where the create fails, the build stops at the macro rather than at the line that could not write.

The remaining four are weaker and the item should not lean on them. `:44` and `:53` write stamps nothing reads; they exist for `cargo:rerun-if-changed`, so their absence affects relink freshness, not whether the build succeeds. `:71` is a no-op success rather than a failure, because `crates/chan-server/resources/.gitkeep` is tracked so the directory is present in any snapshot and `create_dir_all` returns Ok on an existing directory. `:74` writes the empty model stub, but the file is consumed only under a non-default feature: `crates/chan-server/src/embed_seed.rs:16` is `#![cfg(feature = "embed-model")]`, its `include_bytes!` is at `:24`, and `crates/chan-server/Cargo.toml` has `default = ["embeddings"]` with `embed-model` opt-in. So `:74` fails at a distance only under `--features embed-model` with no prior `make models`. The source draft used `:74` as its worked example, which is the weakest of the six.

The contrast that names the fix is inside the repository. `desktop/src-tauri/build.rs:135-136` performs the same class of write with `.expect`, so it fails loudly at the line that could not write. `crates/chan-server/build.rs` fails silently and resurfaces at a distance.

### Why this belongs here and not in a general error-suppression sweep

Making these writes loud and mounting the source read-only are the same change arriving from opposite directions. Done independently, in either order, the second one breaks the build, and the reason is that a read-only cargo working directory is not hypothetical here: `scripts/windows-cross-check.sh` already has one. It binds `$REPO:/src:ro` at `:72`, does `cd /src` at `:62`, and runs `cargo check --release -p chan` at `:65`, which reaches `chan-server`'s build script because `crates/chan/Cargo.toml:38` depends on it.

- **Making the writes loud alone breaks `make windows-cross-check`.** That check passes today only because the writes are discarded. `:38` creates `web/dist` and `web-launcher/dist` on the host worktree first, so `:23` and `:35` succeed, but nothing creates the two build stamps or the model stub, and all three are gitignored. On this checkout at registration time none of the three files exists, so `build.rs:44`, `:53` and `:74` are all failing silently on the read-only mount on every run of that check right now. Made loud without another change, the check fails at `:44`.
- **Mounting a tracked snapshot alone breaks the build too, and less legibly.** `web/dist` and `web-launcher/dist` are gitignored, so they are absent from a `git ls-files` snapshot, `:23` and `:35` fail silently, and the failure surfaces as a rust-embed missing-folder error somewhere else entirely.
- **Both directions need the same third piece**: the driver creating the gitignored build inputs inside the tree the build actually reads. `scripts/windows-cross-check.sh:38` does exactly that on the host worktree today, which is this item's own subject applied by hand.

So the three changes are one change. A general sweep over discarded `Result`s would land the loud half on its own schedule, in a commit that has no reason to know about a container mount, and would take `make windows-cross-check` down with it. That sweep is out of scope here; see Boundaries.

## Contract

- **Every sdme container this repository creates uses the btrfs backend. Overlay is never used here.** This is the owner's standing rule and it holds whether or not the container is capped, so a driver may not fall back to overlay and may not leave the backend to `auto`, which resolves to overlay.
- Every container a chan build creates is capped, and its consumption is visible to the same `btrfs qgroup` accounting every other container on the pool is measured by. The cap is a consequence of the rule above rather than the reason for it: `--disk` applies only to btrfs, so a container that obeys the backend rule is one that can be capped at all.
- A driver that cannot apply the backend or the cap says so and fails, rather than silently creating an overlay or uncapped container.
- Documentation that shows a reader how to create a container shows the form the rule requires, so a contributor following it does not produce the thing the rule forbids.
- A container that produces a verdict reads a source tree no edit made outside it can change for the duration of the run, and the driver states the revision it read.
- Immutability during the run is a property of the crates that permit it, not a requirement imposed on crates that generate into their own source tree.
- No driver binds the repository writable into a container running as root.
- A build write whose failure a later step depends on reports that failure at the line that could not write.

## Boundaries

In scope, by path: the five drivers that build chan from this tree, `packaging/nix/build-with-sdme.sh`, `packaging/sdme/build-chan-desktop.sh`, `scripts/windows-cross-check.sh`, `packaging/distros/arch/build-with-sdme.sh` and `packaging/distros/copr/build-with-sdme.sh`; `crates/chan-server/build.rs`, for the six writes of section 3; and `packaging/distros/copr/build-srpm.sh`, which is not an sdme driver at all but carries the writable root bind section 2 names. The two stub harnesses move with the drivers they cover: `packaging/nix/test-build-with-sdme.sh` and `packaging/distros/copr/test-build-with-sdme.sh`.

The backend rule reaches further than the rest of this item, so its surface is stated separately. In scope for the backend rule and nothing else in this item: the four container-creating invocations under `packaging/gateway/scripts/dev/sdme/` (`build-gateway.sh:90`, `devserver-tunnel-e2e/build-bins.sh:37`, `devserver-tunnel-e2e/run.sh:115`, `devserver-tunnel-e2e/zone-isolation-probe.sh:27`), the documented `sudo sdme create` in the header of `packaging/sdme/chan-devserver.sdme`, and the three `sdme create` examples in `docs/contributing/linux-and-macos.md`. They are in because the rule is a project rule rather than a build-driver rule: a gateway rig or a contributor following the contributing guide consumes the same shared pool and produces the same unaccounted container. The disk cap, the source-mount work and the build writes stay confined to the five drivers above.

Out of scope, explicitly:

- Everything in the gateway tree apart from the backend flag on those four invocations. Capping them, auditing their mounts and reviewing their rigs are separate registrations; this item touches one argument on each.
- The general sweep over discarded `Result`s. Only the six writes in `crates/chan-server/build.rs` are here, for the reason section 3 gives: a sweep would land the loud half on its own schedule, in a commit with no reason to know about a container mount. The sweep is a separate registration and is bounded away from these six lines.
- A new host-side writable-snapshot arrangement. The owner ruled it out at registration, per the Status line above, because the repository already contains the pattern it proposed to invent. What remains in scope is adopting that pattern or writing down why it does not fit.

## Acceptance

The cheap half is already wired. `packaging/nix/test-build-with-sdme.sh` is run by `make nix-sdme-contract-check` (`Makefile:233-235`) as a `pre-push` step (`Makefile:245`), and its stub sdme records the full `new` argument vector one argument per line at `:115` and the bind list at `:133`. The existing assertions are at `:330-342`, including an exact-two-binds check at `:338` that any change to the mount set has to keep green.

- The cap assertion is on the **pair**: `--storage` with `btrfs`, and `--disk` with a value. A lone `--disk` assertion passes on the currently inert form and proves nothing. Asserting against the recorded argument vector is a behaviour check, not a substring test of the script source.
- A guard fails when any container-creating invocation in the tracked tree omits `--storage btrfs`, and it is proven able to fail by adding an unbackended invocation on purpose once and capturing the red. Ten such invocations exist today and the guard has to see all ten, so it enumerates them rather than checking the five drivers it was written against. The guard reads the invocations and not `/etc/sdme.conf`: sdme's default is deliberately left alone, so a container this repository creates has to say `btrfs` itself rather than inherit it from whatever the host happens to be set to.
- N is justified by an observed peak that includes the LTO link, and the item records how it was measured. A mid-compile sample is not a peak.
- A real `make nix-sdme-check NIX_PACKAGE=chan-desktop` completes green under that cap. `--storage btrfs` changes the backend rather than a number, so this run is mandatory rather than optional.
- While that run is alive the container appears in `btrfs qgroup show -r /var/lib/sdme`, and `sdme ps` reports a real cap rather than `-`.
- The three live-binding drivers either read a snapshot or state in the file why a live bind is correct for that use and what the caller must not do while it runs. Only the COPR driver has a stub harness of its own (`packaging/distros/copr/test-build-with-sdme.sh`, run by hand per `packaging/distros/README.md:63`); the Arch driver and `scripts/windows-cross-check.sh` have none, so their evidence is a real run.
- The snapshot helper is shared rather than reimplemented. `packaging/nix/build-with-sdme.sh:123-149` is 27 lines, of which the tar pipeline is 11 (`:139-149`) and the rest is guards. A hand-rolled copy that looks obviously correct loses the guards and the untracked-exclusion property, silently.
- Under a tracked snapshot the driver creates `web/dist` and `web-launcher/dist` inside the snapshot, replacing `scripts/windows-cross-check.sh:38`.
- The `chan-desktop` case adopts `packaging/sdme/build-chan-desktop.sh`'s seed, or the item records what that pattern cannot do. No new writable-snapshot arrangement lands without that comparison written down.
- `crates/chan-server/build.rs:23` and `:35` report their failures. The other four are decided explicitly and the decision is recorded per line, rather than swept up for symmetry.
- The COPR SRPM stage stops binding the repository writable into a root container, or records why it must.

## What no lane can settle on its own

Every check above that is not a stub run needs root on the owner's sdme host and a full release-profile build per run. `/var/lib/sdme` is mode 0700 root, `sdme ps` refuses without root, and the host that carries the checkout has no Rust toolchain. Static reading settles the flags, the mounts, the six discards and the feature gating, and it settled all of them for this item. It settles none of the runtime observations: the 22G and 23G figures, the absent `DISK=` and `STORAGE=` lines in the container state file, the missing qgroup entry, `sdme ps` showing `-`, and the report that `--disk` without `--storage btrfs` warns on stderr in the middle of normal output and exits 0. Those come from the round's measurements on the owner's host and are marked as such wherever they appear above.

## Rough size

The cap is one line of driver plus one assertion, and its whole cost is the validation run and measuring the peak correctly first, which two purpose-built attempts already failed to do. Call it a build's wall clock per attempt, with the instrumentation unsolved.

The mount is medium, and the cost is again validation rather than code: the snapshot helper exists, but three drivers have to be repointed at it and the 534-line Nix contract harness has to stay green through the extraction. Note which driver proves what. The Nix driver never exercises a read-only cargo working directory at all, because it hands Nix `path:/src` (`packaging/nix/build-with-sdme.sh:153`, `:183-188`), which copies into the store and builds there. `scripts/windows-cross-check.sh` does exercise one, but only for `cargo check -p chan`, which never reaches `desktop/src-tauri` and survives its own read-only mount by way of the three silent write failures above. So the pattern documented as the one to copy was proven on the case that hides both of this item's failure modes.

The `build.rs` half is small: six lines to decide, two of which are load-bearing, and it has to land with the driver's directory creation or it turns a silent failure into a hard one.
