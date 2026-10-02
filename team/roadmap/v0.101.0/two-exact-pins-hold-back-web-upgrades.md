# Two exact version pins hold back routine web upgrades

Status: accepted for v0.101.0 by the owner on 2026-09-25; raised for v0.101.0 on the owner's instruction, 2026-09-20, from the development archive's pre-v0.68 backlog. The code claims are a source reading against `main` at `fa0df75ad`. No registry was reachable from the reading host, so what the newer releases do is unmeasured.

## Owner ruling

Accepted on 2026-09-25 as the lead recommended: one dependency lane takes this item and [tower-sessions-lags-and-axum-has-a-dead-feature](tower-sessions-lags-and-axum-has-a-dead-feature.md), and lands with its Nix hashes re-harvested.

On 2026-09-29 the owner ruled on the findings that `npm install` prints and that no item held. Every `npm install` in the integration branch's gate run prints 16 vulnerabilities, 12 moderate and 4 high; no record holds an advisory's detail, so which packages they name, whether they are in what ships or in the tooling, whether each can be reached and whether each has a fix are not established. The owner accepted in one answer every recommendation the lead had put to them that day. For these it was a bounded triage inside this item's lock change, with the fixes that break nothing made in that same change, no item of their own, and what is left written in the release report.

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

## What shipped

Built and accepted on 2026-09-30, on a branch of its own and, until 2026-10-02, on no integration branch: four commits in `web/package-lock.json`, the two manifests, `refAwareLink.test.ts` and one comment in `refAwareLink.ts`, accepted on an independent review of the records, with nothing run by the lead. The lock's move changes the npm dependency hash of the Nix packages, which the owner harvests: the repository's own driver, a Nix build in a disposable guest, refuses to start on the development machine, where the container tool cannot enforce the driver's disk cap over quotas something else enabled, and the lead runs no `nix` on the machine unasked. The range lands with the lead's commit that pins the hash in both Nix packages, and after it every lane's next branch needs `npm ci`.

By the review's reading: vitest and seven `@vitest/*` packages move from 4.1.6 to 4.1.11, `@lezer/markdown` from 1.6.4 to 1.7.2 exact, `mermaid` from 11.16.0 to 11.17.2 with its parser, DOMPurify, devalue, postcss, undici and the root nanoid, and `fastdom` and `strictdom` are new in what ships; the contract test on the internals `refAwareLink.ts` depends on reds against a stub without them; the audit goes from 16 packages and 33 advisories to 9 packages and 7, all in the drawing library adapter's chain with no upgrade that clears them, and npm's one repair for them is a downgrade of that adapter, which is a ruling for the owner before the release. The item's last acceptance point, the Nix packages building against the changed lock, waited on the hash, which is pinned (below).

**Rulings of the lead's, on 2026-09-30:** the Mermaid bump stays, since it is a minor move inside the manifest's range and clears five advisories in code that ships, and what the tests cannot show, since they mock the library and its adapter, is a display check for the owner at rc0, a Mermaid flowchart, a sequence diagram and an Excalidraw block made from a flowchart with a `subgraph`, each painted on the integrated build; until that check the row is integrated and not proved on a display. One changelog entry under Security is owed, the refresh clearing advisories in code that ships, two in DOMPurify and five in Mermaid, and one line under Changed for the Markdown parser's move, an indented table directly below a paragraph and no leaf node starting on an empty line, both written by the lead at the integration. The integration gate is the first real `npm install` over this lock, and an installer error there is this range's finding and not a new one. The release report takes its audit list from the review, with each advisory's own severity.

**On the integration branch since 2026-10-02,** and not on `main`: the four commits were picked as they were, with `web/package-lock.json` and `web/package.json` byte-equal to their branch's, and one more commit pins the npm dependency hash in both Nix packages (`packaging/nix/chan.nix`, `packaging/nix/chan-desktop.nix`). The hash was harvested on the development machine by a Nix build of the fixed-output dependency derivations alone, in a private store removed after the run, at the unpinned tip, and matched again at the pinned one. The combined gate, the first real `npm install` over this lock, was green on Linux with the Nix hash check inside it. Of the last acceptance point that establishes the hash, and not that either Nix package builds, which nothing here ran. The locked versions at that tip are vitest 4.1.11, `@lezer/markdown` 1.7.2, Mermaid 11.17.2 and DOMPurify 3.4.16. The changelog has the Security entry for the refresh; the line under Changed for the Markdown parser's move is not written. The Mermaid display check stays with the owner at rc0, and until it the row is integrated and not proved on a display.
