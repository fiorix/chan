# A devserver build is not identifiable at runtime

Closed: shipped in [v0.87.0](../release/release-v0.87.0.md).

Status: REGISTERED 2026-08-08, deferred to v0.87.0 the same day before the v0.86.0 cut; the server-side sibling of the desktop build identity shipping in v0.86.0, grounded by the same trap firing again during the v086-integration live test. IMPLEMENTED 2026-08-09 in `32520ba2`, with the gateway-hop half of the first acceptance line deferred to the host's production test rather than proven in the round (see below).

## What

Two `chan` binaries from different commits report the same version string between release bumps, and nothing a client can observe names the build that served a response. The 2026-08-08 extension incident spent its first diagnostic cycle unable to tell whether the devserver behind a tunnel was the operator's freshly built integration binary or a day-old process from before the fix under test; the answer had to be inferred from a response-header signature. The v0.85.0 round lost an acceptance cycle to the identical ambiguity on chan-desktop, and this round shipped `CHAN_DESKTOP_BUILD_ID` for it; the devserver has no equivalent.

The restart path makes this worse than a curiosity: a supervised devserver restart relaunches whatever binary the service entry names, not what the operator just built, so "I rebuilt and restarted" plus an unchanged version string is exactly the invisible-skew condition.

## Contract

- A chan build is identifiable at runtime as the specific build it is: `chan --version` and the health surface carry a build id alongside the release version.
- An operator diagnosing through a tunnel can read the serving build's id without shell access to the host.

## Acceptance

- Two builds from different commits are distinguishable via `chan --version` and via the health surface through a gateway-served tenant.
- The id survives the release build path (static musl, Nix) rather than only cargo dev builds.

## Rough size

Small; the desktop lane's `build.rs` shape is the template, plus one field on the health surface.

## Implemented 2026-08-09 (`32520ba2`)

`chan --version` and both health surfaces now name the build that is answering, and they name it with the same string, so an id read through a tunnel and an id read from a terminal are comparable. The release version moves only at a cut, so between cuts it names the previous release on every branch build; the build id is what separates them.

`desktop/src-tauri/build.rs` was the template and it is not sufficient here. It derives the id from git alone, and this crate has to keep its identity through the Nix release path where there is no git to ask: `flake.nix` passes `src = self`, so the source in the store carries no `.git` and a git-derived id stamps `unknown` in exactly the path that has to work. The id is therefore injectable. `CHAN_BUILD_ID` from the build environment wins, git is the fallback for an ordinary checkout, `unknown` is the floor, and `flake.nix` computes the value and hands it down through `env.CHAN_BUILD_ID` in the derivation.

The build script's rules live in `crates/chan/src/build_id.rs` rather than inside `build.rs`. The script pulls them in with `include!` and `lib.rs` mounts the same file under `#[cfg(test)]`, which is what puts a build script's logic under `cargo test`; it otherwise runs unexercised by every test in the repo.

chan-server reports the id from a process-wide set-once cell that `chan::run` declares, not from a field on `AppState` and not from a constant of its own. Both alternatives are wrong for the same reason: one binary serves every tenant in a process, so an id that could differ per tenant would be a lie, and chan-server is a library, so the id belongs to the binary linking it. A binary that embeds chan-server without declaring one serves `unknown`, which is the honest answer rather than an empty field a reader has to interpret.

The flake's chain is guarded rather than a bare `self.shortRev`, and that is load-bearing rather than defensive. A revisionless flake ref carries no `rev` attribute at all, so an unguarded read fails EVALUATION rather than falling back. `make nix-sdme-check` is exactly that case: `packaging/nix/build-with-sdme.sh:133-153` builds a `git ls-files` tarball snapshot with no `.git` and evaluates `path:/src`, so the obvious shape would have broken the one driver that proves this item's own acceptance. Each branch was checked by evaluating a real flake of that shape, since evaluation is where the branch is chosen:

| ref shape | rev-ish attrs `self` carries | build id |
| --- | --- | --- |
| `path:` (no `.git`) | `narHash` only | `nar-531dd8e605dc` |
| `git+file:` clean | `narHash`, `rev`, `shortRev` | `git-b01cdb878f9c` |
| `git+file:` dirty | `dirtyRev`, `dirtyShortRev`, `narHash` | `git-b01cdb878f9c-dirty` |

The middle column is observed rather than inferred, and it is the whole argument: two of the three shapes carry no `rev` at all.

The `nar-` fallback is a real degradation and is recorded as one. A content hash distinguishes different source CONTENT, which is not the acceptance line's "different commits": two commits with identical tracked content, an amend that rewrites only the message or author, or a rebase that preserves the tree, share a narHash and stay indistinguishable. That is the honest floor for a tree that arrived with no history, and it is why the ids are tagged. `git-` and `nar-` are both twelve hex characters and only one can be looked up in the history, while an operator reading an id through a tunnel has no shell on the host to resolve the ambiguity, which is the exact cycle the 2026-08-08 incident lost.

Threading the host's real revision into the sdme path was tried before falling back, and rejected three ways, recorded so the next reader does not re-litigate it: `--impure` plus `builtins.getEnv` costs every consumer of the flake its purity for the sake of a test fixture; writing the rev into the snapshot adds a flake branch only that driver takes, and a stray file of that name in a real checkout would silently outrank the git rev; shipping `.git` and evaluating `git+file:///src` changes what a release-time hash-harvesting tool sees, because the snapshot is built from the INDEX and so carries staged work, while a git flake ref sees commits or a `dirtyRev`.

### Acceptance, line by line

**Two builds from different commits are distinguishable via `chan --version` and via the health surface.** Proven live, on two real binaries from the two commits of this lane, each read three ways:

| commit | `chan --version` | devserver-root `/api/health` | tenant `/api/health` |
| --- | --- | --- | --- |
| `32520ba2eb70` | `chan 0.86.0 (build git-32520ba2eb70)` | `build=git-32520ba2eb70` | `build=git-32520ba2eb70` |
| `a6f9e159821c` | `chan 0.86.0 (build git-a6f9e159821c)` | `build=git-a6f9e159821c` | `build=git-a6f9e159821c` |

All three surfaces agree with each other and with the commit, and the second run needed no cache clearing: moving the checkout's HEAD was enough to restamp the binary on its own, which is the `rerun-if-changed` discipline on `HEAD` and `index` doing its job.

One limitation surfaced while running that proof, and it is recorded rather than fixed. If a build happens where git is not reachable AND no override is set, the resulting `unknown` stamp is STICKY: the build script emits its git `rerun-if-changed` paths only when it can resolve a git directory, so if git later becomes reachable, nothing tells Cargo to restamp and the binary keeps saying `unknown` until something else invalidates the build script. The reverse direction is safe, because a git path that disappears reads as changed and forces a rerun. The shipped paths do not hit this: Nix always injects an override, and CI and developer checkouts always have git from the first build. It bit this verification only because the container was deliberately built without a git dir first and gained one afterwards.

**The id survives the release build path (static musl, Nix).** Proven for Nix, and proven for musl with a stated limit.

Nix: a real `make nix-sdme-check` run of the `chan` package produced a store binary reporting `chan 0.86.0 (build nar-531dd8e605dc)`, with `scripts/smoke-nix-package.sh` green. Before this change that same path stamps `unknown`, which is the defect this item exists for.

musl: a `--target x86_64-unknown-linux-musl` release build produces a `static-pie linked, statically linked` binary reporting `chan 0.86.0 (build git-c0ffee123456)` from an injected id. The limit: that build is `-p chan --no-default-features`, not the shipped tarball. The CI job at `release.yml:171-186` drives `cargo-zigbuild` with zig because the default feature set pulls C++ dependencies `musl-gcc` alone cannot link. So what is proven is the target-specific question, that a musl cross-compile still stamps a real id into a static artifact, and not a reproduction of the release tarball. That CI job takes the git branch of the chain and builds from an `actions/checkout` with a real `.git`.

**Two builds from different commits are distinguishable through a gateway-served tenant.** The gateway hop is NOT proven and is deferred to the host's production test. Reaching a tenant through the proxy needs a running gateway, whose local setup needs a GitHub OAuth dev app's client id and secret (`packaging/gateway/scripts/dev/README.md`); the round did not hold that credential, the auth lane's own gateway requirement was removed by the same wall so there was no stack to borrow, and a survey to the host went unanswered. What is unproven is narrow: whether the `build` field survives the proxy hop unrewritten and uncached.

The specification for that deferred test, so whoever runs it is checking something falsifiable rather than glancing at a plausible string. Open the tenant origin's `/api/health` against a devserver running a build whose id was named IN ADVANCE, then restart onto a second build and reload:

| what the operator sees | what it means |
| --- | --- |
| `build` equals the id named in advance | pass |
| `"build":"unknown"` | the id never reached the binary; the original defect |
| no `build` field at all | the gateway rewrote the body, or an older binary is serving |
| `build` unchanged and `instance` unchanged | the restart did not take; nothing proven either way, retry |
| `build` unchanged but `instance` CHANGED | a new process came up on the OLD binary. That is the supervised-restart skew this item exists to expose, and it means the mechanism worked. |

### Validation

Scoped gate on the lane branch: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test --all-targets`, `cargo build --no-default-features`, `make nix-sdme-contract-check` (`ok - packaging/nix/build-with-sdme.sh contract`), shellcheck over 55 tracked scripts, and actionlint over the workflows.

Eleven mutation probes, each failing exactly the test that claims it and leaving the others green: the override losing to git, a blank override stamping empty, the injected-id character check dropped, the `git-` tag dropped, `--version` losing the build, `--version` substituting the release version instead of appending it, the tenant health handler hardcoding its id, the devserver-root handler hardcoding its id, an undeclared build reading empty instead of `unknown`, and each health surface's wire field renamed off `build`. A twelfth probe passed and was discarded and rewritten: its anchor put the `serde(rename)` on the neighbouring `indexer` field, so it went red through a different test than the one it claimed.

The assertion added to `scripts/smoke-nix-package.sh` was itself probed against a faked Nix output tree, because a check that cannot fail is not a check. It accepts `git-<hex>`, `git-<hex>-dirty`, and `nar-<hex>`, and rejects `unknown`, a missing `(build ...)` clause, an empty id, and an untagged hex id.

One test-suite red during this work was investigated and attributed elsewhere. The suite carries load-sensitive tests that fail under contention on `main` with none of this change present: 3 of 3 iterations under a 1-CPU cap with `--test-threads=32`. Registered separately, not caused by this item and not fixed by it.
