# Extensions v1: loose ends for the merging agent

Left by the 2026-08-02 security review (rulings and amendments are in
`extensions-v1.md`, "Security review amendments (2026-08-02)"; the code batch
is commit `452babfc`). Two items need attention before or at merge.

## 1. Verification is incomplete: browser-smoke 122 + the full pre-push gate

The push of `452babfc` used `--no-verify`; the full pre-push gate
(`scripts/pre-push`) has never run on this branch. Run it before merging.

Browser-smoke check 122 (`scripts/e2e/browser-smoke/checks/122-extension-echo.mjs`)
was attempted in the review environment via `SMOKE_ONLY=122 node
scripts/e2e/browser-smoke/run.mjs` and **failed for an environment reason, not
a code reason**: puppeteer timed out launching Chromium ("Timed out after
30000 ms while waiting for the WS endpoint URL to appear in stdout" — that
string comes from `@puppeteer/browsers`, waiting for the browser's DevTools
socket). The chan server itself came up healthy. Consequence: the
keyboard-relay allowlist (`extensionBridge.ts` `isAdvertisedHostKey`, gated in
`ExtensionTab.svelte`) has unit coverage but no end-to-end confirmation that
relayed `Ctrl+Alt+K` / `Ctrl+Shift+T` still work through a real iframe. Re-run
check 122 in a browser-capable environment before merge; it exercises exactly
that path plus the capability 404, the `frame-ancestors 'self'` header, and
extension process reaping.

## 2. Glossary terms live only in the main checkout's untracked CONTEXT.md

The review captured two terms in `CONTEXT.md` in the **main** working
checkout (`~/dev/github.com/fiorix/chan/CONTEXT.md`), which is untracked
there and invisible to this branch. Decide where the glossary lives and
commit it; the intended content of the two entries is:

- **Extension**: A user-supplied local binary declared by a hand-written TOML
  file in `~/.chan/extensions/`; chan-server discovers, spawns, and
  supervises it, and the SPA surfaces it as a tab. Trusted user code by
  construction — dropping the TOML is code-execution-equivalent, so a
  malicious extension binary is outside the threat model. The threats that
  count are other local processes and cross-origin web content attacking the
  extension's endpoint, and extension content attacking the chan SPA. Works
  wherever chan works — local or devserver, any client connection method;
  chan is tunnel-agnostic about extensions. Tunnel guests (non-owner
  participants) are read-only on extension routes, matching the house
  `require_local_mutation` model. _Avoid_: plugin (implies in-process),
  marketplace/installer connotations.
- **Extension capability path**: The per-run random 256-bit URL segment in
  `/_chan/extensions/<id>/<capability>/` that is the iframe's only
  credential. Deliberately outside the `/api` bearer domain so extension
  JavaScript never possesses a chan credential; the chan bearer only gates
  the catalog that discloses it, and the extension's own token travels only
  on chan's private upstream leg. _Avoid_: token in URL (the extension token
  never appears browser-side).
