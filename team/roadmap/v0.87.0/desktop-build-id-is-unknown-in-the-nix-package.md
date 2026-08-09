# The Nix-built chan-desktop stamps `unknown` as its build id

Status: REGISTERED 2026-08-09 during the v0.87.0 delivery round, from an incidental
observation in the `devserver-build-identity` lane. Not implemented; registered rather
than fixed because the round's scope was locked at three items and the fix is a different
crate from the one that lane owns.

## What

`CHAN_DESKTOP_BUILD_ID` shipped in v0.86.0 to make a chan-desktop build identifiable at
runtime, after the v0.85.0 round lost an acceptance cycle to exactly that ambiguity. It
is derived in `desktop/src-tauri/build.rs:14-30` from `git rev-parse --short=12 HEAD`
plus a `-dirty` suffix, falling back to the string `"unknown"` when the build happens
outside a git checkout.

That fallback fires in the Nix path. `flake.nix:48` passes `src = self` to
`packaging/nix/chan-desktop.nix`, and the flake source in the Nix store has no `.git`, so
`nix build .#chan-desktop` stamps `unknown` in a package users install.

It is a shipped path, not a corner: `flake.nix` sets `packages.default = chan-desktop`,
so `nix run github:fiorix/chan` is the desktop, and the flake's `nixConfig` block
publishes the closure to `chan.cachix.org` for consumers who accept it.

**Scope precision — the other desktop packages are NOT affected.** The AppImage, deb, and
dmg path builds through `actions/checkout@v6` (`.github/workflows/release-desktop.yml:34`),
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
   binary is multi-call: `desktop/src-tauri/src/main.rs:4838-4852` dispatches the whole
   `chan` CLI when argv[0]'s stem is `chan`), and `postInstall:80-81` symlinks
   `bin/chan` and `bin/cs` at it. Because `chan-desktop.nix` takes no `buildId` argument,
   the `chan` crate's build script runs with no override inside that derivation and falls
   through to its own `unknown` branch.

So after v0.87.0 a user who installs `#chan` gets a real id, while a user who installs the
desktop package — the flake default — gets `unknown` from both `chan-desktop` and the
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
shipped-package defect is `flake.nix:48` passing `src = self`: the release path is itself
a no-`.git` build. That step, and the `bin/chan` second surface above, are code readings
rather than executed Nix builds, and should be confirmed by building `.#chan-desktop` and
reading both ids out of the package before the fix is designed.

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
  assertion into `scripts/smoke-nix-package.sh` — which already smokes both packages, so
  the hook exists.

## Rough size

Small, and the shape is already settled by the server-side sibling: an injectable env
override preferred over a git-derived id, with `flake.nix` passing the rev through the
derivation, plus a guarded fallback chain because a `path:` flake ref carries no `rev` or
`shortRev` at all and an unguarded reference fails evaluation rather than degrading. The
`devserver-build-identity` implementation is the template to copy, including whatever
fallback it settles on, threaded to two derivations instead of one. Doing both crates in
one pass would have been cheaper; the round's scope lock is why they are split.
