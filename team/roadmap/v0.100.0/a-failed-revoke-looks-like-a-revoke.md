# A failed revoke looks like a revoke

Status: raised for v0.100.0 on the owner's instruction to fold the frontend review's most critical findings into this version. From the review (findings PROFILE-01, PROFILE-02 and PROFILE-03, medium, on the credential surface, plus the profile half of its gate holes), re-verified against `main` at `d3de0180b` by reading. The review reproduced both failures against stubbed 403 responses, which the identity service answers on every management endpoint for a blocked account.

## What was seen

The gateway identity SPA, `web/packages/profile`, is where a user revokes a personal access token and removes someone's grant to a devserver, which is shell-equivalent access to a machine.

**Token revoke.** `revoke()` in `src/views/Tokens.svelte` is three statements with no `try`: a confirm, `await api.revokeToken(id)`, `await refresh()`, called from an `onclick` that neither awaits nor catches. When the DELETE fails the row stays as it was, no message appears, and the rejection escapes unhandled. The user believes a credential is dead while it is live. `create()` and `toggleAudit()` in the same file both catch.

**Grant revoke.** `removeGrant` in `src/views/Devservers.svelte` writes `grantsError[devserverId]` in its catch, and the share panel renders that error ahead of the grant list. One failed DELETE replaces the list of who holds access with one error line. `loadGrants` returns early on a warm cache and the panel's toggle does not force a reload, so collapsing and reopening does not clear it, and there is no retry.

**A native dialog.** The token revoke asks through a bare `confirm(...)`. The house rule forbids native dialogs because they fail silently in a WebView, and the guard that enforces it (`web/packages/launcher/src/no_native_dialogs.test.ts`) misses this twice: it only globs the launcher, and its pattern requires the `window.` prefix.

**No way to test any of it.** `web/packages/profile/vite.config.ts` imports `defineConfig` from `vite`, not `vitest/config`, and has no `test` block, so the package's gated suite runs in the node environment and passes only because its one test file is DOM-free.

## Desired contract

A failed revoke says it failed, next to the thing that was not revoked, and the list of tokens or grants stays visible and current. Revocation is confirmed through the app's own modal. The package can mount a component in a test.

## Boundaries

`web/packages/profile/src/views/Tokens.svelte`, `src/views/Devservers.svelte`, `vite.config.ts` (the `vitest/config` import and the jsdom block with the svelte client alias that `web-shared` and the launcher already carry), new mounted tests, and the native-dialog guard widened to bare `alert`, `confirm` and `prompt` and to every SPA package. No change to the identity service.

## Acceptance

1. A token revoke answered 403 shows an error on that row, keeps the row, and leaves no unhandled rejection.
2. A grant revoke answered 403 keeps the grant list on screen with the error beside it, and a retry is possible without reloading the page.
3. Token revoke confirms through the in-app modal, and the guard fails on a bare `confirm(` anywhere in the three SPAs.
4. `make web-check` runs the profile suite under jsdom.
