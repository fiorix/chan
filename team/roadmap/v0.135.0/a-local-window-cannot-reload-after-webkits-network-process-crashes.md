# A local window cannot reload after WebKit's network process crashes

Status: accepted by the owner on 2026-11-26 (the last section); not started. Not built in v0.135.0, so the GA commit moves it to the next version (D125).

Record: found on the owner's Mac on 2026-11-26 as a side effect of check 2 of the v0.135.0 readings, where the owner's agent named it a candidate row of low priority (`dev/v0135-team/evidence/owner-mac-results-v0135.md`, check 4, "Side effect of check 2"); the lead put it to the owner (`dev/v0135-team/decisions.md`, D124 item 2).

## What is there now

Read at `aabb9d039`, by reading, except the reading named.

- The reading, in WKWebView on the owner's Mac with a release build of `5915fd54f`: check 2 dropped the network by killing the test app's own WebKit Networking process, which WebKit relaunches. After those kills, a reload of the first test window landed on "access token missing" (the `shells` API answered 401). A window opened after the kills reloaded three times with its token.
- The page keeps its token in session storage. On load it takes `?t=` from the URL, stores it under `chan.token`, removes it from the URL, and otherwise reads it back from session storage (`loadToken`, `web/packages/workspace-app/src/api/transport.ts:81-92`; the key at `:40`). A reload therefore finds its token only in session storage.
- The cause is inferred by the owner's agent from the contrast between the two windows, not traced in WebKit: this WebKit keeps session storage in its network process, so the kill dropped it while the page went on with the token in memory.
- chan-desktop's `reload_window` (`desktop/src-tauri/src/main.rs:4603-4614`), behind Cmd+R and, through the page's `reloadWindow` (`web/packages/workspace-app/src/api/desktop.ts:376-389`), behind the terminal card's Reload window (`web/packages/workspace-app/src/components/TerminalTab.svelte:3731`), retargets a devserver window from its connection's feed, which gives it a fresh URL (`reload_devserver_window_from_feed`, `:4619`), and otherwise runs `window.location.reload()`. The owner's agent read the consequence: a local window whose WebKit network process crashes cannot be reloaded, by Cmd+R or by the terminal card's Reload window, and must be reopened; the devserver path re-mints its URL on reload, and the local path does not.
- Not read: WebKitGTK and WebView2; a network process that crashes by itself rather than by a kill.

## Desired contract

1. In chan-desktop, a reload of a local window whose page has lost its stored token lands in its workspace, by Cmd+R and by the card's Reload window, without reopening the window.
2. A reload whose token is still in session storage, and a devserver window's reload, behave as today.

## Boundaries

- The local window's reload path in chan-desktop and, if the fix needs it, the page's token load in `api/transport.ts`, with their tests.
- The token is not moved to storage that outlives the window's session (local storage, a cookie) without the owner's word: a draft constraint, not a reading.
- A plain browser tab outside chan-desktop is not in scope.

## Acceptance

1. A test of the local window's reload path, red at the base: a reload of a local window gets a working token without session storage.
2. On the owner's Mac, at the base and then at the tip: kill the test app's WebKit Networking process as check 2 did, then reload a local window by Cmd+R and by the card's Reload window; red at the base (the missing-token page), green at the tip.
3. The same kill and reload on WebKitGTK in an isolated guest, recorded here whether or not that engine loses session storage the same way.

## The options as drafted

- (a) chan-desktop's reload of a local window navigates to the window's URL with a fresh token, as a devserver window's reload does (recommended: one path for Cmd+R and the card's button, and the page keeps its token rule).
- (b) The page hands its in-memory token back to the URL before a reload it starts itself. It covers only reloads the page starts.

## Accepted, 2026-11-26

Accepted by the owner on 2026-11-26 ("app and workspace recommendations are good to me", `dev/v0135-team/decisions.md`, D125, which names it "reload after a WebKit network crash"). Drafted as a lead document and not built in v0.135.0, so the GA commit moves it to the next version (D125). The options above are the lead's draft, with (a) recommended; the owner's word did not choose among them.
