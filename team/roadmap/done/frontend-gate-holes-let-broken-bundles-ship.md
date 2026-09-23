# Holes in the frontend gate let broken bundles and unchecked code ship

Status: shipped in [v0.100.0](../../release/release-v0.100.0.md): Everything that ships or renders a verdict runs under a `make ci-*` target, and a release job that builds a bundle by hand asserts the bundle exists before compiling it in.

## What was seen

**The Windows package jobs never check that the bundles exist.** `windows-artifacts` in `.github/workflows/release.yml` and the Windows leg of `build` in `.github/workflows/release-desktop.yml` both build the two embedded SPA bundles by hand (`npm install`, then the launcher and workspace-app builds) and go straight into `cargo build --release`. A comment says both bundles must exist or "LauncherAssets bakes an empty dir". The Nix derivations assert exactly that (`test -f web-launcher/dist/index.html` and `test -f web/dist/index.html` in `packaging/nix/chan.nix` and `chan-desktop.nix`); no workflow does. A silent npm failure bakes an empty launcher into the signed NSIS installer and nothing turns red.

**Unused code is invisible to the compiler.** `noUnusedLocals` and `noUnusedParameters` are off in all four TypeScript packages. The review measured the cost of turning them on: zero errors in three packages, 38 in 20 files in the workspace app. It found 336 instances of that class by hand.

**A floating promise is invisible everywhere.** None of the three SPA entry points (`src/main.ts` in the workspace app, the launcher and the profile SPA) installs an `unhandledrejection` handler; the only one under `web/` is inside a test. Several findings of this release are rejections nobody saw.

**Shipped and verdict-bearing JavaScript has no static check.** `web/packages/marketing` runs `node --check` over its scripts in `make web-marketing-check`. Nothing runs any check over `scripts/e2e` (17,059 lines of JavaScript in 59 files, whose only product is a verdict) or over `desktop/src` (1,486 lines of framework-free JavaScript, HTML and CSS shipped in every desktop release). The marketing list itself covers 13 of its 14 scripts.

**The launcher's test setup differs from the app's.** The launcher's vitest config has no `setupFiles`, so the storage shim the workspace app's tests rely on is missing there, and a test moved between the packages changes behaviour.

The profile SPA's missing jsdom environment is handled in [a-failed-revoke-looks-like-a-revoke](a-failed-revoke-looks-like-a-revoke.md), where the tests that need it are written.

## Desired contract

The Makefile's own rule holds: CI runs the `make ci-*` targets, so anything absent there is ungated, and nothing that ships or renders a verdict is absent. A release job that builds a bundle by hand asserts the bundle exists before it compiles it in.

## Boundaries

`.github/workflows/release.yml` and `release-desktop.yml` (two `test -f` lines after the npm build line in each job); the four `tsconfig.json` files plus the 20 workspace-app files that fail the new flags; the three `main.ts` files, each routing into its app's existing notice sink; the `Makefile` (an `e2e-check` target running `node --check` over `scripts/e2e/**/*.mjs` and `desktop/src/*.js`, wired into the `ci-*` chain beside `web-marketing-check`); `web/packages/marketing/package.json` for the fourteenth script; `web/packages/launcher/vite.config.ts`. No linter joins the gate in this item.

The unused-code flags touch files every frontend lane owns, so this item's TypeScript half lands first, before the lanes diverge, or it collides with all of them.

## Acceptance

1. Each new check is shown red once on purpose before its green counts: a deliberately unused local, a syntax error in an e2e check, a missing `index.html` in a workflow dry run or an equivalent local reproduction of the step.
2. `make web-check` is green with both unused-code flags on in all four packages.
3. A rejected promise with no handler produces a visible notice in each SPA, asserted in a mounted test per entry point.
4. `make pre-push` and the `ci-*` chains run the e2e and desktop static check.
5. `make workflow-check` is green on the two edited workflows.
