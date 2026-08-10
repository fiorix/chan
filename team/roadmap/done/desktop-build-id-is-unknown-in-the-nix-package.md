# The Nix-built chan-desktop stamps `unknown` as its build id

Closed: shipped in [v0.88.0](../../release/release-v0.88.0.md).

Status: REGISTERED 2026-08-09 during the v0.87.0 delivery round, from an incidental
observation in the `devserver-build-identity` lane; registered rather than fixed there
because that round's scope was locked at three items and the fix is a different crate from
the one that lane owns. IMPLEMENTED in v0.88.0: `flake.nix` threads its guarded `buildId`
into `chan-desktop.nix`, which sets both `CHAN_BUILD_ID` and `CHAN_DESKTOP_BUILD_ID`, and
`chan-desktop --version` was added so the app's own id is readable without a display.
Three Nix builds report a real id from both the app and the `bin/chan` that package ships,
agreeing within each build and differing across them (`nar-0923cd094492`,
`nar-4da689f51e1c`, `nar-aabc995562f4`), asserted from now on by
`scripts/smoke-nix-package.sh`. Two limits, neither of them a fallback to `unknown`: every
id observed is `nar-` rather than `git-` because each rig evaluates a `path:` flake over a
snapshot carrying no `.git`, so the desktop build script's git branch was exercised by no
build in this round; and that branch now emits a `git-` tag where it previously emitted
bare hex, a format change the AppImage, deb and dmg path will show on its next release run
and which nothing here observed.

## What

`CHAN_DESKTOP_BUILD_ID` shipped in v0.86.0 to make a chan-desktop build identifiable at
runtime, after the v0.85.0 round lost an acceptance cycle to exactly that ambiguity. It
is derived in `desktop/src-tauri/build.rs` (`emit_build_id`) from `git rev-parse --short=12 HEAD`
plus a `-dirty` suffix, falling back to the string `"unknown"` when the build happens
outside a git checkout.

That fallback fires in the Nix path. `flake.nix` passes `src = self` to
`packaging/nix/chan-desktop.nix`, and the flake source in the Nix store has no `.git`, so
`nix build .#chan-desktop` stamps `unknown` in a package users install.

It is a shipped path, not a corner: `flake.nix` sets `packages.default = chan-desktop`,
so `nix run github:fiorix/chan` is the desktop, and the flake's `nixConfig` block
publishes the closure to `chan.cachix.org` for consumers who accept it.

**Scope precision: the other desktop packages are NOT affected.** The AppImage, deb, and
dmg path builds through `actions/checkout@v6` (`.github/workflows/release-desktop.yml`, its `uses: actions/checkout@v6` step),
which leaves a real `.git`, so the git fallback stamps a true id there. This item is about
the Nix-built package specifically; a flat "the shipped desktop build id is unknown" would
be wrong for the packages most users install.

## Two surfaces, one root cause

The Nix desktop package is affected twice, and whoever picks this up should not fix half:

1. **`chan-desktop` itself** stamps `CHAN_DESKTOP_BUILD_ID=unknown`, from
   `desktop/src-tauri/build.rs`.
2. **`bin/chan` in that same package** reports an `unknown` build id too, even after the
   v0.87.0 `devserver-build-identity` work lands. `packaging/nix/chan-desktop.nix` builds
   with `cargoBuildFlags = ["-p" "chan-desktop"]`, which links the `chan` CLI in (the
   binary is multi-call: `desktop/src-tauri/src/main.rs` (`run_as_chan_if_requested`) dispatches the whole
   `chan` CLI when argv[0]'s stem is `chan`), and its `postInstall` symlinks
   `bin/chan` and `bin/cs` at it (`ln -s chan-desktop "$out/bin/chan"`). Because `chan-desktop.nix` takes no `buildId` argument,
   the `chan` crate's build script runs with no override inside that derivation and falls
   through to its own `unknown` branch.

So after v0.87.0 a user who installs `#chan` gets a real id, while a user who installs the
desktop package, the flake default, gets `unknown` from both `chan-desktop` and the
`chan` it ships. Same argument threaded to a second derivation, but a second surface.

The v0.87.0 fix does not reach either: `CHAN_DESKTOP_BUILD_ID` comes from a separate build
script on a separate crate, and `chan-desktop.nix` accepts no build-id argument at all.

## Evidence, 2026-08-09

Observed by the `devserver-build-identity` lane during an unrelated
`cargo clippy --all-targets -- -D warnings` run inside a build container with no `.git`:
the desktop build script emitted

```
cargo:rustc-env=CHAN_DESKTOP_BUILD_ID=unknown
```

Same mechanism, same string, same cause as the server-side gap that item exists to fix.

The container observation on its own proves only that a no-`.git` build stamps `unknown`,
which is the documented best-effort behaviour rather than a defect. What makes it a
shipped-package defect is `flake.nix` passing `src = self` in the `chan-desktop` `callPackage`: the release path is itself
a no-`.git` build. That step, and the `bin/chan` second surface above, are code readings
rather than executed Nix builds, and should be confirmed by building `.#chan-desktop` and
reading both ids out of the package before the fix is designed.

## Confirmed empirically 2026-08-09, at the released version

The item was registered with its second surface flagged as a code reading rather than an executed build, and said it should be confirmed by building `.#chan-desktop` and reading the id out of the package. The v0.87.0 release verification did exactly that, on a full `NIX_PACKAGE=all` run with zero hash mismatches and both packages smoked:

- `.#chan` reports `build nar-34649cccac21`
- `chan-desktop`'s shipped `bin/chan` reports `build unknown`

So the prediction is now an observation, on a real Nix output at the version being released, and the gap narrows to one hop: `packaging/nix/chan-desktop.nix` does not hand a build id down to the `chan` it ships.

Two things this settles beyond the item. The injectable override works in the packaging path most likely to defeat it, since `.#chan` stamps a nar-derived id rather than falling back to `unknown` where there is no `.git`. And the release-tarball path was independently confirmed from the other direction: the shipped musl binary from the GA run reports `chan 0.87.0 (build git-479c102e2471)`, the GA commit's own sha, which is `devserver-build-identity`'s acceptance criterion met on a real release artifact.

The Nix smoke deliberately excludes `chan-desktop` from the build-id assertion and says so at the exclusion site, naming this item as where the gap lives. That is the shape to keep: a check that skips a known defect and is legible about it, rather than one that is silently absent.

**"The shape to keep" was right about the principle and is now wrong about the code**, and both halves matter. The exclusion is gone as of the implementation below, because a documented skip over a closed gap is just a stale comment; what survives is the reason it was written that way. A silently absent check would have left nobody able to find this item from the smoke, and the legible exclusion is how the gap stayed visible for a release. Keep the principle, not the four lines.

## Contract

- A chan-desktop build from the **Nix** path is identifiable at runtime as the specific
  build it is, matching what the AppImage/deb/dmg path already does.
- The `chan` binary shipped inside that package reports the same real id, not `unknown`.
- The id degrades deliberately and visibly rather than silently collapsing to `unknown`
  in a path that ships.

## Acceptance

- `.#chan-desktop` built through Nix reports a real build id, not `unknown`.
- `bin/chan` from that same package reports a real build id.
- Two `.#chan-desktop` builds from different commits are distinguishable by that id.
- The check is enforced rather than eyeballed once, the way the server-side item wires its
  assertion into `scripts/smoke-nix-package.sh`, which already smokes both packages, so
  the hook exists.

## Implemented 2026-08-10 (v0.88.0)

Both surfaces now carry a real id, from one `buildId` threaded to one derivation that
compiles two crates.

`flake.nix` hands its existing guarded `buildId` to `chan-desktop.nix`, which sets
**both** `CHAN_BUILD_ID` (the `chan` crate linked into the multi-call binary and
symlinked at `bin/chan`) and `CHAN_DESKTOP_BUILD_ID` (the app). Those are read by
different build scripts, which is why setting one is the half-fix this item warned
about. `desktop/src-tauri/build.rs` gains the injected override it lacked, with the
semantics `crates/chan/src/build_id.rs` settled: an override wins, blank counts as
absent, and a malformed value stops the build rather than falling back, because the id
is emitted as a `cargo:rustc-env=` line where a newline would forge further directives.

The desktop's git-derived id is now tagged `git-`. That is required rather than
cosmetic: `nar-` ids reach this same field through the Nix path, both shapes are 12 hex
characters, and only one can be looked up in the history. Nothing parses the string
(checked the IPC surface, the About window and `web/`), so no consumer breaks.

### The surface that did not exist

Proving the app's own id needed a headless reader. `CHAN_DESKTOP_BUILD_ID` had exactly
three consumers, all in `main.rs` and named rather than numbered because this
item's own change moved two of them: `native_vocabulary`'s `build:` field, the
`"chan-desktop starting"` tracing line, and `open_about_window`'s `let build =`.
A Tauri IPC command, a `tracing` line
emitted once the GUI is up, and the About window. All three need a display; the Nix
smoke runs in a container. So `chan-desktop --version` now prints the version and id and
exits, sequenced **after** the `chan` and `cs` stem probes.

That ordering is load-bearing and has its own test. `bin/chan` is a symlink at this same
binary, so a probe running first would answer `chan --version` with the desktop id and
hide whether the `chan` crate ever received one; and because both ids carry the same
value, the substitution would be invisible in the output.

Grepping the binary was considered and rejected for the same reason, recorded because it
is the obvious shortcut: both variables carry the same value, so a match cannot be
attributed to either one, and the check would pass on exactly the half-fix above.

### Acceptance, line by line

**`.#chan-desktop` built through Nix reports a real build id, and so does its `bin/chan`.**
Proven on a real Nix output, `make nix-sdme-check NIX_PACKAGE=chan-desktop` equivalent
(`packaging/nix/build-with-sdme.sh`, `NIX_PACKAGE=chan-desktop`), output
`/nix/store/rf9cjj6gk5s7rqzyz81g4m27z1k39552-chan-desktop-0.87.0`:

```
chan 0.87.0 (build nar-0923cd094492)
chan-desktop 0.87.0 (build nar-0923cd094492)
built devserver smoke: PASS
Nix package smoke: PASS (chan-desktop at /nix/store/rf9cjj...-chan-desktop-0.87.0)
```

Compare the same package at v0.87.0, recorded above: `chan-desktop`'s `bin/chan`
reported `build unknown`. That is the before-and-after on real artifacts from the same
path, not a prediction.

The result was read three independent ways rather than from an exit code: the status
file the guest itself writes (`0`), the driver's exit, and the `PASS` lines in
`build.log`. This matters because a piped `make` invocation on a host without `make`
returned exit 0 earlier in this round, from `tail` rather than from the build.

The ids are `nar-` rather than `git-` because the sdme driver evaluates a `path:` flake
over a `git ls-files` snapshot with no `.git`.

That is worth stating as more than a caveat. The `path:` shape is not a degradation the
guarded chain tolerates; it is the case the chain **exists for**, and these runs are the
first to exercise it end to end on the desktop package. `self` carries no `rev` attribute
at all on a revisionless ref, so an unguarded `self.rev` fails **evaluation** rather than
falling back, and the build would not have started. Anyone tempted to simplify that chain
into a bare `self.shortRev` should note that the only builds proving this item are the ones
that would break first.

**Two `.#chan-desktop` builds from different commits are distinguishable.** Proven on two
real builds of differing tracked content:

| build | `chan --version` | `chan-desktop --version` |
| --- | --- | --- |
| first | `nar-0923cd094492` | `nar-0923cd094492` |
| second | `nar-4da689f51e1c` | `nar-4da689f51e1c` |

Different ids across the two, identical within each, which is the pair of properties the
fix has to deliver at once: the package identifies its build, and its two binaries agree
about which build that is.

The limit of the `nar-` form is the one this item already records and it applies here: a
content hash distinguishes different source CONTENT, so two commits with identical tracked
trees would share an id. These two differ in content, so the line is met. A `git+file:`
build takes the `git-` branch instead and distinguishes commits directly.

**The check is enforced rather than eyeballed once.** `scripts/smoke-nix-package.sh` now
asserts a well-formed tagged id from `chan --version` for both packages, asserts the same
from `chan-desktop --version` for the desktop package, and asserts the two agree, since
one derivation and one `buildId` mean a disagreement is a stale or mis-fed variable. The
deliberate exclusion comment is gone because the gap it described is closed.

The assertion was probed against a faked Nix output tree, the method
`devserver-build-identity` used on this same script, because a check that cannot fail is
not a check. Ten cases: green for `nar-`, `git-` and `git--dirty`; red for the desktop
reporting `unknown` (this item's defect), `chan` reporting `unknown` (the v0.87.0
observed state), the two ids disagreeing (the half-fix), a missing `(build ...)` clause
on either binary, an untagged bare 12-hex id (the pre-fix desktop format), and an empty
id. The greens are green only in the sense a fake supports: both id lines parse and
validate, then the run fails at the devserver smoke, which no fake binary can answer.
Verified by reading the output rather than by an exit code.

## Rough size

Small, and the shape is already settled by the server-side sibling: an injectable env
override preferred over a git-derived id, with `flake.nix` passing the rev through the
derivation, plus a guarded fallback chain because a `path:` flake ref carries no `rev` or
`shortRev` at all and an unguarded reference fails evaluation rather than degrading. The
`devserver-build-identity` implementation is the template to copy, including whatever
fallback it settles on, threaded to two derivations instead of one. Doing both crates in
one pass would have been cheaper; the round's scope lock is why they are split.

**The estimate was right about the packaging and missed a surface.** Threading the id was
indeed small: three files, and two of them a few lines. What it did not anticipate is that
the id would be **unreadable** once stamped. `CHAN_DESKTOP_BUILD_ID` had no headless
consumer, so the acceptance line "`.#chan-desktop` reports a real build id" could not be
checked by anything that cannot open a display, and closing it needed a new pre-GUI
`--version` probe in `main.rs` plus a test pinning its position. That is a runtime-surface
change in a different crate from the one this item names, and it needed a boundary grant to
make.

The general form, since this round found the same shape elsewhere: **an estimate that sizes
"make the value correct" has not sized "make the value observable".** Those are separate
questions and only the first one was asked here.
