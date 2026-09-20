# Two exact version pins hold back routine web upgrades

Status: raised for v0.101.0 on the owner's instruction, 2026-09-20, from the development archive's pre-v0.68 backlog. The code claims are a source reading against `main` at `fa0df75ad`. No registry was reachable from the reading host, so what the newer releases do is unmeasured.

## What was seen

`web/package.json` pins `vitest` to exactly `4.1.6`, the only exact pin among caret ranges there, and nothing beside it says why. The backlog records the reason: from 4.1.7 the runner fails a run on an unhandled rejection, and a fire-and-forget `deleteSession` cleanup fetch rejected from a timer in a tabs test. That call now reads `void api.deleteSession().catch(() => {})` in `web/packages/workspace-app/src/state/store.svelte.ts`, so the recorded cause may already be gone and the pin may be holding nothing.

`web/packages/workspace-app/package.json` pins `@lezer/markdown` to exactly `1.6.4`. That pin is load-bearing: `editor/markdown/refAwareLink.ts` intercepts link closing through `InlineContext.parts` and the delimiter `side` field, which the library marks `@internal`, so a minor release is free to change them. `refAwareLink.test.ts` exists beside it.

## Desired contract

Owner ruling, 2026-09-20: do what is safe.

For vitest, safe is measured: run the suite on the current release, and if it is clean the pin becomes a caret range like its neighbours; if it is not, the rejection it reports is fixed at its source and then the pin goes. For `@lezer/markdown`, safe is a pin that says why it exists and a test that fails loudly when the internals move, so a bump is a deliberate act with a signal, not a routine one with a silent regression. The bump itself happens only if that test passes on the newer release.

## Boundaries

`web/package.json`, `web/packages/workspace-app/package.json`, `web/package-lock.json`, `refAwareLink.ts` and its test. A lock change here does not touch `Cargo.lock`, but the Nix package carries an npm dependency hash that follows `package-lock.json`.

## Acceptance

1. The full web suite runs on the newest vitest 4 release and the result is recorded: clean, or the named rejection and its fix.
2. `vitest` is a caret range, or the item records the measured reason it cannot be.
3. The `@lezer/markdown` pin carries a comment naming `refAwareLink.ts` and the internals it depends on.
4. A test fails when `InlineContext.parts` or the delimiter `side` field is absent or changes shape, proven by running it against a stub without them.
5. `make web-check` is green, and the Nix packages build against the changed `package-lock.json`, with their npm dependency hash re-harvested if the lock moved.
