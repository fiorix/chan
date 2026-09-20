# Nothing pins the one packaging recipe whose shape could ship a test-only feature

Status: raised for v0.101.0 from the v0.99.0 fix loop's follow-ups, where gating a startup hook behind a test-only feature surfaced the question and it was parked. A source reading of the recipes and the manifests against `main` at `d3de0180b`; no package was built.

## What was seen

chan-workspace has a `test-hooks` feature and chan-library a `test-util` feature, each enabled only from chan-server's dev-dependencies (`crates/chan-server/Cargo.toml`). They therefore reach a build only when an invocation both selects chan-server and builds dev units, which no shipping recipe does: every one is a release build of `chan` or `chan-desktop` with no dev units.

One recipe is close to the line. `packaging/distros/arch/aur/chan/PKGBUILD.in` runs `cargo test --frozen --release -p chan` in `check()`, between `build()` and the install of `target/release/chan`, and that test run relinks the binary the package then installs. It stays clean only because `-p chan` does not select chan-server. Nothing in the tree pins that selection: a later widening of `check()` to the workspace would enable both features in a shipped binary silently, and a stripped release binary makes it undetectable afterwards. The desktop recipe beside it has the same shape to keep honest.

## Desired contract

A shipped binary cannot carry a test-only feature, and the packaging recipes' package selection is pinned by a check that fails when it widens, rather than by the memory of why it is narrow.

## Boundaries

`packaging/distros/arch/aur/chan/PKGBUILD.in` and `packaging/distros/arch/aur/chan-desktop/PKGBUILD.in`, the packaging checks under `scripts/`, the Makefile target that runs them, and the feature declarations in `crates/chan-workspace/Cargo.toml`, `crates/chan-library/Cargo.toml` and `crates/chan-server/Cargo.toml`.

## Acceptance

1. A check reads both recipes and fails when `check()` selects anything beyond the package the recipe installs; it is red against a copy widened to the workspace and green against the recipes as they stand.
2. The check runs in the pre-push gate and in CI, so a recipe edit cannot land without it.
3. A recorded dependency-tree reading for the shipped packages shows neither test-only feature enabled, with the command that produced it written next to the check.
