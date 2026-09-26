# Nothing pins the one packaging recipe whose shape could ship a test-only feature

Status: landed in one lane with [a-service-spawned-extension-gets-a-bare-path](a-service-spawned-extension-gets-a-bare-path.md), whose second round answered an independent review of its first and was checked by the lead; accepted for v0.101.0 by the owner on 2026-09-25; raised for v0.101.0 from the v0.99.0 fix loop's follow-ups, where gating a startup hook behind a test-only feature surfaced the question and it was parked. A source reading of the recipes and the manifests against `main` at `d3de0180b`; no package was built.

## What was seen

chan-workspace has a `test-hooks` feature and chan-library a `test-util` feature, each enabled only from chan-server's dev-dependencies (`crates/chan-server/Cargo.toml`). They therefore reach a build only when an invocation both selects chan-server and builds dev units, which no shipping recipe does: every one is a release build of `chan` or `chan-desktop` with no dev units.

One recipe is close to the line. `packaging/distros/arch/aur/chan/PKGBUILD.in` runs `cargo test --frozen --release -p chan` in `check()`, between `build()` and the install of `target/release/chan`, and that test run relinks the binary the package then installs. It stays clean only because `-p chan` does not select chan-server. Nothing in the tree pins that selection: a later widening of `check()` to the workspace would enable both features in a shipped binary silently, and a stripped release binary makes it undetectable afterwards. The desktop recipe beside it has the same shape to keep honest.

## Desired contract

A shipped binary cannot carry a test-only feature, and the packaging recipes' package selection is pinned by a check that fails when it widens, rather than by the memory of why it is narrow.

## What shipped

- **The check.** `check_aur_check_selection_contract` in `scripts/check-build-matrix.py` reads both recipes (`AUR_RECIPES`); for each, `check_aur_recipe` takes the package from `pkgname=`, requires `package()` to install `target/release/<pkgname>`, and reads `check()` command by command. Every building cargo call must select that package alone with `-p`, where `$pkgname` and `${pkgname}` resolve to it. Words after `--` belong to the test binaries and are not read, and a subcommand that builds nothing (`fetch`, `metadata`, `tree` and the like) is skipped.
- **The refusals.** A building cargo call is refused for `--workspace` or `--all`, `--manifest-path`, no `-p`, a package other than the recipe's (as `-p X`, `-pX`, `--package X`, `--package=X` or a `p` in a short-flag cluster), any feature flag (`--features`, `-F`, `--all-features`), or a shell expansion before `--` other than `$pkgname`. Any other command is refused when its program is a variable or one of `bash`, `eval`, `gmake`, `just`, `make`, `sh` and `xargs`, or when it names cargo anywhere but as its program (behind `timeout`, `env` or `sudo`, in a brace group, an `if` or a `for`, or in a command substitution). A `check()` with no building cargo call left is refused too, so the contract cannot outlive the shape it pins. A refused command is named with its line in the recipe.
- **Where it runs.** `scripts/test-check-build-matrix.py` writes a throwaway recipe per shape, 49 of them, runs each through the checker's `aur-recipe` entry point and requires it to pass or be refused as the contract says, a refusal naming the line its shape starts on (except a `check()` with no cargo call, which is refused by file), then runs the real recipes. `make build-matrix-check` runs the checker and then that self-test, and `check_make_contract` pins the self-test's line in the target. `pre-push` runs `build-matrix-check`, and so does CI: `make ci-linux` through `pre-push`, and `make ci-macos` and `make ci-windows` directly.
- **The recorded reading.** The contract's docstring carries the command, `cargo tree --locked -p <package> --target x86_64-unknown-linux-gnu -e normal,build,dev --prefix none --format '{p} [{f}]'`, and its result: `-e dev` resolves features with dev units the way `cargo test` does, and neither the `chan` nor the `chan-desktop` tree enables `test-hooks` or `test-util`, while `chan-server`, the control, enables both, as do the widened selections the contract refuses. The lane's run for x86_64 and aarch64 is `dev/v0101-tasks/evidence/extp/aurc-3-feature-reading.log`.
- The item's premise holds for `chan`, whose integration tests make `check()` relink the binary `package()` installs. `chan-desktop` has no integration test today, so its `check()` leaves the `build()` binary in place; its recipe is pinned all the same. `.agents/skills/gate/SKILL.md` lists the contract under `build-matrix-check`.

One gap stays open: this contract reads the recipes and not the manifests, so it would not catch a dev-dependency in `crates/chan/Cargo.toml` that enabled a test-only feature under `-p chan`.

## Boundaries

`packaging/distros/arch/aur/chan/PKGBUILD.in` and `packaging/distros/arch/aur/chan-desktop/PKGBUILD.in`, the packaging checks under `scripts/`, the Makefile target that runs them, and the feature declarations in `crates/chan-workspace/Cargo.toml`, `crates/chan-library/Cargo.toml` and `crates/chan-server/Cargo.toml`.

## Acceptance

1. A check reads both recipes and fails when `check()` selects anything beyond the package the recipe installs; it is red against a copy widened to the workspace and green against the recipes as they stand.
2. The check runs in the pre-push gate and in CI, so a recipe edit cannot land without it.
3. A recorded dependency-tree reading for the shipped packages shows neither test-only feature enabled, with the command that produced it written next to the check.
