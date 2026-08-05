# chan-desktop cannot open a library window: the flow depends on `window.open`

Status: REGISTERED for v0.85.0, DEFERRED from v0.84.1 on 2026-08-05, filed and grounded 2026-08-05 by live owner testing, implemented, owner validation pending. The accepted approach shipped: the desktop mints and raises library windows through two capability-gated native commands, and the browser keeps `window.open`. What remains is owner acceptance on real macOS hardware, which is the only place a WKWebView delivering an invoke from a remote https page can be observed.

It moved out of v0.84.1 because the repair needs a new native command and its capability wiring, which is more than a patch release should carry: an SPA-only branch was written, tested live, and reverted (see Attempted and reverted). The v0.84.1 diagnostic work that came out of this investigation SHIPPED and stays in v0.84.1.

This item was originally filed as a gateway CSRF/IPC-grant failure triggered by a gateway outage;
live testing disproved that framing entirely, and the disproof is recorded under Ruled out so it is
not re-litigated.

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

Why it returns null is settled, and it is an omission rather than a platform limit. wry 0.55.1
implements the macOS UI delegate `webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:`
(`wry-0.55.1/src/wkwebview/class/wry_web_view_ui_delegate.rs:140`), but its whole body is gated on
`new_window_req_handler` being set; unset, it returns nil. tauri-runtime-wry only sets that handler
`if let Some(new_window_handler) = pending.new_window_handler`
(`tauri-runtime-wry-2.11.2/src/lib.rs:4908-4910`), whose public knob is
`WebviewWindowBuilder::on_new_window` (`tauri-2.11.2/src/webview/webview_window.rs:315`).
chan-desktop never calls it: zero hits across `desktop/src-tauri/src/`, and every builder site
(`serve.rs:1048`, `main.rs:5144`, `main.rs:6479`) omits it.

Enabling that handler was evaluated and rejected. Both `NewWindowResponse::Allow` and
`Create { window }` produce a SECOND window: `native_label(record)` is
`format!("{}::{}", record.library_id, record.window_id)` (`window_watcher.rs:46-48`), the SPA opens
its popup before the record exists (`CommandLauncher.svelte`, popup at the top of
`createScopedWindow`, record created by the action that follows), so no correct label is knowable at
popup time — and `reconcile` opens the properly-labelled native window for every `should_show`
record that is not already on screen (`window_watcher.rs:255-269`). On a gateway origin the popup
window would also carry a label the minted `lib-*` capability does not match, reproducing the
ungranted-window class v0.83.4 closed.

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

## Attempted and reverted (2026-08-05)

A desktop branch in `CommandLauncher.svelte` that skipped the popup and let the window watcher open
the record was implemented and tested live on a local window. It creates the record -- the launcher
lists it -- but NO native window ever appears, and the row's focus control does nothing because
there is no window of any kind behind it. Reverted.

The cause is server-side and cannot be fixed from the SPA: the scoped library action mints with
`WindowOrigin::Browser` hardcoded (`crates/chan-server/src/routes/library.rs:825` for a terminal,
`:837` for a workspace window), and the watcher deliberately refuses browser-origin records --
`should_show` requires `record.origin.is_native()` (`window_watcher.rs:230-236`), documented at
`:216` as "a browser-minted window is never opened as a native twin" and pinned by a test at
`:500-504`. The branch therefore produced orphan records, which is worse than the honest error it
replaced.

## Implementation shape (accepted approach)

The desktop mints the record; the web route is not taught to mint native windows. This keeps "may
cause a native window to open" inside the Tauri capability system that already scopes `lib-*`
windows to one authenticated exact origin, rather than resting it on a client-supplied `window_id`
that the HTTP mint authorizes only as a live window of the tenant.

- `create_library_window` and `focus_library_window` in `desktop/src-tauri/src/main.rs`. Both resolve the target library from the INVOKING window's own label, so a window reaches only its own library: `{library_id}::{window_id}` yields `local` or `lib-<hex>`, a `workspace-*` label resolves to the local library, and every other label is refused.
- Creation mints a NATIVE-origin record. The local library goes through the embedded host, a devserver library through `devserver::mint_library_window`. The window watcher opens the OS window.
- Focus raises through `unbury_window`, the same path the launcher's `/open` route drives, and it persists `hidden = false` on the way, so the SPA does not also send the scoped visibility action.
- Hiding and closing another window depended on the same popup handle and failed the same way. They run the scoped action alone: both mutations make the record fail the watcher's show test, so the reconcile closes the OS window without a native command or any new authority.
- The opaque `workspace_id` is resolved to a root path on the desktop side, so no filesystem path is accepted from the page.
- Permission wiring goes in the `workspace-window` set only. The runtime-minted capability lists `"workspace-window"` as its first permission, so a permission in that set already reaches gateway-served `lib-*` windows on their exact origin; listing it again in `exact_origin_capability_json` would be a redundant literal, not a second grant. `allow-gateway-csrf-token` is listed separately precisely because it is deliberately NOT in that set, so it is the wrong pattern to copy for a command every window class needs.
- The full-gate parity table needs no new entry. `origin_aware_acl_grants_spa_invoke_vocabulary_per_window_class` enforces `DELIBERATE_EXCLUSIONS` in both directions, and with both permissions in the `workspace-window` set all four origin classes are granted, so an exclusion entry would fail the test rather than satisfy it.
- `web/packages/workspace-app/src/api/libraryWindows.ts` owns the desktop/browser split; the two `tauriInvoke` call sites stay in `api/desktop.ts`, which is the file the ACL parity test parses.

## Acceptance checks

Discharged by automated evidence:

- The desktop branch does not call `window.open` and the browser branch still does. Driven through the real functions in `web/packages/workspace-app/src/api/libraryWindows.test.ts`, which fails on exactly the desktop cases when the branch regresses while the browser cases keep passing.
- Both commands are granted on all four window/origin classes, and denied on a sibling tenant, the proxy apex, a wrong port, an unrelated remote origin, and a non-`lib-*` label.

Owner acceptance, not reachable by any test on a headless host:

- In chan-desktop, in BOTH a gateway-served and a local window: the Computers scope lists, activating an existing window brings it to front, and creating a terminal or workspace window opens a native window.
- In a browser tab, the existing `window.open` behaviour is unchanged.

## Assumption carried

`workspace-*` labels map to the local library on the strength of the desktop's own `library_id: "local"` declaration in the `WindowSpec` it builds for those windows, not on a live observation that the Computers scope lists in a `workspace-*` window. The mapping exists so that class does not hold the permission and then error on use.

## Boundaries

The browser path is not to be changed; this is about giving desktop its own. The v0.83.4 contract
that no gateway-window feature may depend on the `ipc://` custom protocol still stands and is
satisfied by the postMessage fallback.

## Open

- **Settled, kept here as the rationale for the accepted approach.** The alternative rule --
  derive the minted origin from the acting window's origin, server-side -- was rejected as weaker
  than it sounds. The command
  capability binds a client-supplied `window_id` (`library.rs:518-521`), and the mint handler
  authorizes it only as "a live window of this tenant"
  (`tenant_has_live_window` / `tenant_token_has_live_window`, `library.rs:735-753`), never as "the
  caller's own window". Window ids are listed in the library snapshot, so any client that can mint
  at all -- including a plain browser tab on the loopback origin, which gets `Owner` because role
  falls back to Owner when there is no `TunnelOrigin` (`library.rs:725-734`) -- could name a NATIVE
  window as its acting window and thereby cause chan-desktop to open real OS windows. That is not a
  cross-user escalation (tunnel guests are `Readonly` and refused at `:815`), but it moves "may
  cause a native window to open" from the desktop to any tenant-authenticated web surface, with UI
  spam as the cheap abuse and the opened window's native vocabulary as the expensive one.
  Hence Implementation shape above: the desktop mints, through a capability-gated command, so the
  ACL that already scopes `lib-*` windows to an exact origin governs this too.
- **Settled: raising an already-visible native window now has a surface.** `focus_library_window` is
  it. It raises through `unbury_window`, the same path the launcher's `/open` route drives, and
  persists `hidden = false` on the way, so the SPA does not also send the scoped visibility action
  and the two cannot disagree.
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
