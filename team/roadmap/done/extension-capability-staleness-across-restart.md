# A surviving page holds dead extension capabilities after a devserver restart

Status: SHIPPED in [v0.86.0](../../release/release-v0.86.0.md). Extension tabs converge after a devserver restart via catalog re-resolution and frame reconciliation, with live headless-browser red and green proofs.

## What

The extension URL's 64-hex segment is a per-extension, per-process random capability (`extensions.rs:602`, `:656-664`), re-minted on every devserver start. The SPA fetches the catalog once per page load and memoizes it forever (`extensions.svelte.ts:29-39`); focusing an open extension tab never re-navigates the frame (`tabs.svelte.ts:4393-4409`). The only refresh is a full page reload from `checkServerInstance`, which fires only on a watch-socket reconnect and silently skips when its `/api/health` read fails (`store.svelte.ts:2052-2069`), a path that is exactly fragile over a tunnel while the devserver is coming back.

So a page that outlives a devserver restart keeps a mounted iframe whose base capability is dead: the document renders from memory, its `app.js` fetch 404s. A fresh page load cannot be stale by construction (persisted tabs carry only `extensionId`, `tabs.svelte.ts:589-594`), which is why the failure looks random: it selects for long-lived windows.

Adjacent but documented behaviour, out of scope unless the owner widens it: extensions spawn once at server boot with no respawn (`extensions.rs:683`, `docs/config-reference.md:72`).

## Contract

- After a devserver restart, a surviving page converges to working extension tabs without a manual reload: the catalog re-resolves on watch reconnect, and a mounted frame whose capability is no longer current is re-navigated to the fresh entry path or falls through to the unavailable state.
- A failed health read during recovery retries rather than silently skipping the reload decision.

## Acceptance

- Restart the devserver under an open extension tab; the tab returns to working without user action, over both loopback and a tunnel-served window.
- The stale case is proven able to fail first: with the fix withheld, the surviving tab 404s; with it, the same sequence converges.

## Rough size

Small to medium: catalog re-resolution and frame reconciliation in the SPA, plus the health-retry; no server changes required.
