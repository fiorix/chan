# chan-desktop cannot open a library window: the flow depends on `window.open`

Status: REGISTERED for v0.84.1, filed 2026-08-05, grounded 2026-08-05 by live owner testing,
accepted, not yet specced. This item was originally filed as a gateway CSRF/IPC-grant failure
triggered by a gateway outage; live testing disproved that framing entirely, and the disproof is
recorded under Ruled out so it is not re-litigated.

Component: `workspace-app` SPA (`web/packages/workspace-app`) and `chan-desktop`
(`desktop/src-tauri`). Observed on chan-desktop 0.84.0, devserver 0.84.0, gateway 0.84.0.

## What

In chan-desktop, opening a window from the command deck's Computers/library scope fails with:

> **This library** — The browser blocked the new Chan window   [Back] [Retry]

The scope itself lists correctly; it is creating or activating a window from it that fails. Retry
never succeeds, and neither does closing the window, reconnecting the gateway, or restarting the
app.

The message is wrong twice over: chan-desktop has no popup blocker, and nothing about the browser is
involved. It sends the user looking for a setting that does not exist.

Severity is functional, not data-losing. There is no workaround from inside chan-desktop; the same
action works in a browser tab against the same devserver.

## Verified current state (2026-08-05)

`window.open` returns null in a gateway-served chan-desktop WebView. Verified live in the Web
Inspector with "Emulate User Gesture" enabled:

```js
String(window.open("", "_blank"))   // => "null"
```

- In a gateway-served window
  (`https://<tenant>.p1.usr.chan.app/chan-<hex>/index.html?w=w-<hex>&lib=lib-<hex>`): `"null"`.
- In a local, non-gateway window (`http://127.0.0.1:55893`, label `local::w-<hex>`): `"null"`.

The console probe alone is weak evidence, because `window.open` legitimately returns null without
user activation. The decisive measurement is the real flow under a real click, and it fails in both:

- Gateway-served window: the command deck's Computers scope reports the popup failure.
- Local window: identical failure, same scope, same click path.

Both call sites throw on exactly that null, and the thrown string matches the observed error
verbatim:

- `createScopedWindow` — `web/packages/workspace-app/src/components/CommandLauncher.svelte:317-318`,
  which opens the popup before its first await specifically to keep the browser's popup grant.
- `popupFor` — the same file at `:282-283`, used to activate an existing window record.

Supporting facts:

- The flow has no desktop branch at all: neither `CommandLauncher.svelte` nor
  `web/packages/workspace-app/src/api/libraryCommand.ts` references `isTauriDesktop` or
  `tauriInvoke`. The browser window-management model is used unconditionally.
- No `window.open` shim is injected. The desktop's initialization scripts
  (`desktop/src-tauri/src/serve.rs:984-1053`, `KEY_BRIDGE_JS` at `:2085`) do not touch it.
- `CommandLauncher.svelte` is byte-identical between v0.83.4 and v0.84.0, so neither round regressed
  it.
- v0.83.4's live smoke of "the Computers scope" covered the scope listing — a read whose CSRF
  delivery that round fixed — not window creation from it. That is how the round passed with this
  path broken.

The failure is chan-desktop-wide, not gateway-specific: a local window fails the same click path the
same way. The reading is that this has never worked in chan-desktop. What would falsify it: any
chan-desktop build in which the Computers scope opens a window, or in which
`String(window.open("", "_blank"))` returns a Window under an emulated user gesture.

A related fact, established while measuring this: in a local window the ACL correctly refuses
`gateway_csrf_token` (a local window is not a gateway window), so a refusal record always exists
there. That is expected, and it is the reason the first version of the desktop wording — keyed on a
recorded refusal — fired in local windows and told the user to reconnect a gateway that was not
involved.

### Ruled out (live, not inferred)

- **Not CSRF.** `gateway_csrf_token` resolves with a real token in the affected window, through
  Tauri's postMessage fallback. Evaluated directly in that window's console.
- **Not the `ipc://` mixed-content block.** WebKit blocks `ipc://localhost/gateway_csrf_token` as
  insecure content on the HTTPS page and Tauri falls back to postMessage ("IPC custom protocol
  failed, Tauri will now use the postMessage interface instead"). This is expected, is already
  governed by the v0.83.4 contract in
  [`done/gateway-served-surface-failures.md`](../done/gateway-served-surface-failures.md), and the
  fallback works. The "Not allowed to request resource" console error IS this block; reading it as a
  capability refusal is what sent the original investigation wrong.
- **Not the Tauri ACL.** The invoke is stopped by the page's mixed-content policy before ACL
  resolution, and the fallback succeeds, so no capability is refused.
- **Not gateway-specific.** A local chan-desktop window (`http://127.0.0.1:<port>`, label
  `local::w-<hex>`) fails the same Computers-scope click path identically.
- **Not outage-triggered.** Reproduced with the tunnel healthy and no outage, and the failure
  survives a full disconnect, keychain-token deletion, fresh OAuth re-authorization, and reconnect.
- **Not the runtime capability mint.** A gateway conn only exists in memory via `main.rs:2520`, 24
  lines after the mint at `:2496`, and an origin change forces a full reconnect through
  `gateway.rs:433-445` (pinned by `moved_row_tears_down_drops_the_pin_and_reconnects`). The
  `ensure_exact_origin_grant` repair this item originally proposed would have been a no-op and was
  deliberately not implemented.

## Contract

In chan-desktop, opening or focusing a library window must not depend on `window.open`. The command
deck's library actions complete through the native window path on desktop, and keep the existing
`window.open` path in a browser.

No user-facing message may attribute a chan-desktop failure to a browser popup blocker.

## Implementation shape

- Branch the two call sites on `isTauriDesktop()`.
- On desktop, skip the popup entirely: run the scoped action and let the existing window watcher
  reconcile the new record into a native window (`desktop/src-tauri/src/window_watcher.rs`, the
  `should_show` reopen path), which is already the mechanism for devserver-driven windows.
- For activating an existing record, replace `popup.focus()` with a native focus/show path rather
  than a popup handle.
- Rekey `blockedWindowMessage` (`web/packages/workspace-app/src/api/desktop.ts`) on
  `isTauriDesktop()` alone. As shipped in `aee1ede4` it keys on a recorded `gateway_csrf_token`
  refusal, which this investigation shows never occurs, so the corrected wording is currently dead
  code.

## Acceptance checks

- In chan-desktop, in BOTH a gateway-served and a local window: the Computers scope lists,
  activating an existing window brings it to front, and creating a terminal or workspace window
  opens a native window.
- In a browser tab, the existing `window.open` behaviour is unchanged.
- Unit: the desktop branch does not call `window.open`, and the browser branch still does.
- Unit: `blockedWindowMessage` returns the desktop wording under `isTauriDesktop()` with no CSRF
  refusal recorded.

## Boundaries

The browser path is not to be changed; this is about giving desktop its own. The v0.83.4 contract
that no gateway-window feature may depend on the `ipc://` custom protocol still stands and is
satisfied by the postMessage fallback.

## Open

- Why `window.open` returns null in chan-desktop at all — whether wry/Tauri simply does not
  implement the WKWebView `createWebViewWith` UI delegate, or it is configurable. If it is
  configurable, enabling it is a smaller repair than re-routing the flow, and that should be
  settled before the desktop branch is written.
- What the native activation path for an existing window record should be — whether an existing
  command already covers focus/show, or one is needed.
- Whether the launcher's capability model
  (`web/packages/launcher/src/state/capabilities.ts`, which already distinguishes client-side
  `window.open` management from a native bridge) should be shared with `workspace-app` rather than
  duplicating the branch.
- Whether any other `workspace-app` surface makes the same unconditional `window.open` assumption.

## Appendix: verification commands

```sh
# the two throw sites, and the absence of a desktop branch
grep -n 'window.open' web/packages/workspace-app/src/components/CommandLauncher.svelte
grep -rn 'isTauriDesktop\|tauriInvoke' \
  web/packages/workspace-app/src/components/CommandLauncher.svelte \
  web/packages/workspace-app/src/api/libraryCommand.ts   # empty

# the flow did not change in the v0.84.0 round
git diff v0.83.4 v0.84.0 -- \
  web/packages/workspace-app/src/components/CommandLauncher.svelte   # empty
```

In the affected window's Web Inspector, with "Emulate User Gesture" enabled:

```js
String(window.open("", "_blank"))                            // "null"
(window.__TAURI_INTERNALS__?.invoke)("gateway_csrf_token")   // resolves with a token
```
