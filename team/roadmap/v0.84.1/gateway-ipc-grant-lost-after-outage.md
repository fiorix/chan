# Gateway `lib-*` windows lose their IPC grant after a gateway outage

Status: REGISTERED for v0.84.1, filed 2026-08-05, accepted, investigation pending. The v0.84.1
diagnostic (`aee1ede4`) ships; the repair does not, because the cause is not yet known. The
outage-shaped explanation this item was filed under has since been DISPROVED by owner experiment
(see Retired hypotheses); the title is kept for continuity with the field report.

Component: `chan-desktop` (`desktop/src-tauri`). Observed on chan-desktop 0.84.0, devserver 0.84.0,
and gateway 0.84.0, all three at the same tag.

## What

In a gateway-served devserver window (observed on a standalone terminal window,
`geekom Terminal Window 2`), opening the Computers scope from the command deck fails with "This
library — The browser blocked the new Chan window", offering Back and Retry. Retry never succeeds,
and closing and reopening the window does not help. The WebView console carries the real cause:

```
Not allowed to request resource                                    sendIpcMessage — user-script:274:83
Fetch API cannot load ipc://localhost/gateway_csrf_token
    due to access control checks.                                  sendIpcMessage — user-script:274:83
```

The stack is `sendIpcMessage` -> `action` -> `value` -> `R_`/`z_` (`index-*.js`) -> `y`/`ee`
(`client-*.js`). The SPA is asking the desktop shell for the gateway CSRF token and Tauri's ACL
refuses the invoke before it reaches any command handler. Without the token the SPA's double-submit
mirror sends no `x-chan-csrf`, so the library window cannot be created.

Severity is functional, not data-losing: the Computers/library scope and every native-transfer
command are dead in an affected window until the user quits the app. The user-facing message
actively misdirects toward a popup blocker.

The reported workaround is a full quit of chan-desktop (Cmd+Q — closing the window is not enough)
followed by relaunch and reopening the devserver. Its stated rationale, that the relaunch is what
puts the connection back through `connect_rostered_devserver`, is retired: the owner experiment
below reached that same path without a quit and the refusal survived. Whether the full quit
genuinely clears the condition is therefore unconfirmed.

## Verified current state (2026-08-05)

`gateway_csrf_token` is deliberately absent from the build-time `workspace-window` permission set
and is granted only by a runtime-minted capability
(`desktop/src-tauri/permissions/app.toml:199-201`):

```toml
# Deliberately NOT in the workspace-window set: only an authenticated exact
# gateway origin needs the native mirror, and the runtime-minted capability is
# the authority that binds that origin to its lib-* windows.
[[permission]]
identifier = "allow-gateway-csrf-token"
commands.allow = ["gateway_csrf_token"]
```

That capability is minted in exactly one non-test place: `desktop/src-tauri/src/main.rs:2496`,
inside `connect_rostered_devserver` (`:2469`), reached only from `connect_devserver_impl_inner`
(`:2631`) — that is, only on a fresh rostered-gateway connect. The mint is
once-per-origin-per-process and cannot be undone
(`desktop/src-tauri/src/runtime_capability.rs:109`, early-out at `:119-121`):

```rust
let mut minted = minted_origins().lock().unwrap_or_else(|e| e.into_inner());
if minted.contains(&urls[0]) {
    return Ok(false);
}
```

The module doc states the constraint plainly at `runtime_capability.rs:17`: there is no
`remove_capability`, so a removed gateway's grant persists until the app restarts.

The gap is that every recovery path restores a gateway connection to healthy without ensuring the
grant for its current `proxy_origin` exists.

1. `reconnect_devserver` (`main.rs:3046`), gateway branch at `:3054`:

   ```rust
   if conn.gateway.is_some() {
       if devserver::fetch_workspaces(&conn).await.is_ok() {
           state.devserver_feed.set_down(&id, false);
           let _ = app.emit(serve::SERVES_CHANGED, ());
           return Ok(true);      // marked healthy — no mint
       }
       return Ok(false);
   }
   ```

2. `spawn_devserver_workspace_poll` (`main.rs:1060`), the automatic 5s poll. Its recovery arm
   (`:1084`) flips `set_down(&id, false)` and emits `DEVSERVER_CONTROL_RESTORED_EVENT`. No mint.

Contrast `reconnect_devserver_for_window` (`main.rs:4460`), which recovers correctly because it
tears down and re-runs the full connect, so the mint happens:

```rust
teardown_devserver_connection(&app, &state_arc, &id).await;
connect_devserver_impl(app.clone(), state_arc, id).await?;   // -> mints
```

So the desktop has two recovery paths that report success while leaving the IPC authority
untouched, and one that repairs it. Whether a window works after an outage depends on which path
happened to run.

The field trigger, as originally read: a production gateway rollout (0.83.3 -> 0.84.0) replaced the
`devserver-proxy` pod. The tunnel dropped at 17:16:40 and did not re-establish until 17:19:57, a
roughly three-minute outage. The desktop rode this out as a disconnect plus automatic poll
recovery, never a fresh connect. Afterwards `gateway_csrf_token` was refused in the affected window
while the connection showed healthy in the launcher. The outage is real and the two recovery paths
really do skip the mint, but the owner experiment below shows the outage is not what causes the
refusal.

### Retired hypotheses (2026-08-05, owner experiment)

The owner deleted the keychain item holding the `gw.chan.app` token, disconnected the gateway,
reconnected (which forced a fresh browser OAuth authorization), then reopened the geekom machine and
the launcher menu. The failure was identical.

That path runs `connect_rostered_devserver`, the only place a grant is minted, and the window is
created after the mint. So the grant for the current `proxy_origin` exists and the window still
cannot use it. This retires both hypotheses this item was filed under:

- The "never minted" shape is retired independently by code: a gateway conn only exists in memory
  via `main.rs:2520`, 24 lines after the mint at `:2496`. The other two conn-set sites (`:2790`,
  `:3085`) are the non-gateway paths, and `gateway.rs:1389` is inside a `#[tokio::test]`. The
  recovery paths cannot run for a gateway conn unless a mint already succeeded for its origin.
- The "stale origin" shape is retired by `gateway.rs:433-445`: an origin change arrives as a roster
  `moved` diff, which tears the connection down and fires `devserver_reconnect_hook`, wired at
  `main.rs:5039-5053` to the full connect, which mints the new origin. The test
  `moved_row_tears_down_drops_the_pin_and_reconnects` (`gateway.rs:1377`) pins this.

Consequently the `ensure_exact_origin_grant` repair this item originally proposed would be a no-op
against the observed failure, and was deliberately not implemented.

Also checked and NOT the cause: `remote.urls` carries a bare origin with no path, but Tauri rewrites
an empty-or-`/` pathname to `*` before matching (`tauri-utils-2.9.2/src/acl/mod.rs:284-296`), so the
pattern matches every path on the origin. A window at a sub-path is fine.

### Ruled out

Established with evidence during triage; these do not need re-litigating.

- Not the gateway. `ipc://localhost` is Tauri's local IPC and the failing call never leaves the
  machine. Gateway-side the node logged zero 403s over the whole day, and the unsafe methods a
  missing CSRF token would break were succeeding for other windows in the same period
  (`POST /api/library/windows` -> 200, `PUT /api/terminal/api/session` -> 204,
  `DELETE /api/library/windows/...` -> 204). The tunnel was up with a valid `admission_lease` at
  `protocol_version: 2`.
- Not version skew. `gateway_csrf_token` does not exist anywhere in v0.83.3
  (`git grep -l gateway_csrf_token v0.83.3 -- desktop/ web/` is empty); it arrived in v0.83.4. Both
  halves here are 0.84.0, so the command and its SPA caller are present.
- Not a window-label mismatch. The minted capability scopes to `windows: ["lib-*"]`, and
  gateway-served windows, standalone terminals included, carry composite `lib-<hex>::w-<hex>`
  labels (the buried-terminal comment near `desktop/src-tauri/src/serve.rs:620`, and the
  `starts_with("lib-")` guards at `desktop/src-tauri/src/devserver.rs:1111` and `:1133`). The label
  matches.

## Open

The grant for the window's origin exists and the ACL still refuses the invoke, so the mismatch is
between what the capability binds and what the window presents. The mint binds three things —
`windows: ["lib-*"]`, one exact origin in `remote.urls`, and the command list — and the refusal
means at least one does not match at resolution time. Unresolved, in the order the diagnostic will
answer them:

- The origin the window presents versus the `exact_origin` that was minted. `proxy_origin` and
  `proxy_apex_origin` are both carried on the connection (`devserver.rs:117-124`) and only the
  former is minted.
- The label the window presents versus `lib-*`. The handler-side `starts_with("lib-")` guards pass
  for these windows, but the handler never runs; nothing has confirmed the label the ACL sees is the
  same string.
- Whether Tauri re-resolves a runtime-added capability for a webview that already existed when
  `add_capability` ran. The module doc asserts it does ("Already-open windows on the origin gain the
  grant on their next invoke"); that assertion is unverified against tauri 2.11.2.

The v0.84.1 diagnostic (`aee1ede4`) answers the first two directly: the SPA records the refused
window's origin and label and logs each distinct refusal once, and the desktop logs the
`exact_origin` at mint. The refusal record is deliberately not filtered on a `lib-*` label, since a
window presenting an unmatched label is one of the candidates.

## Contract

Not yet stated: the contract depends on which of the above is true, and writing one now would pin
the wrong invariant. The originally proposed contract ("grant presence is an invariant of a healthy
gateway connection") is retained below as the shape the repair should take IF the cause turns out to
be grant absence, which the owner experiment currently contradicts.

## Implementation shape (conditional, not accepted)

- Extract an idempotent `ensure_exact_origin_grant(&app, &proxy_origin)`. The existing
  `mint_exact_origin_grant` already no-ops on a second call, so this is mostly a matter of calling
  it in the right places.
- Call it from the recovery paths before they report healthy: `reconnect_devserver`'s gateway
  branch (`main.rs:3054`) and `spawn_devserver_workspace_poll`'s recovery arm (`main.rs:1084`).
- If the investigation lands on (b), key the mint set by `(devserver_id, proxy_origin)` and re-mint
  when the origin changes, accepting the documented duplicate-accumulation cost.
- Consider surfacing a refused `gateway_csrf_token` invoke as a visible desktop error. Today it
  appears only in the WebView console, and the user-facing message misdirects toward a popup
  blocker.

## Acceptance checks

For the v0.84.1 diagnostic, which is what actually ships: reproduce the refusal with both halves
rebuilt from this base — the SPA lives in the devserver (`crates/chan-server/src/static_assets.rs`
bakes `web/dist/`), the mint log in chan-desktop — and confirm the console carries
`[chan-desktop] gateway_csrf_token refused` with a non-empty origin and label, and the desktop log
carries `minted the gateway-window capability` with an `exact_origin`. Covered by unit tests in
`web/packages/workspace-app/src/api/desktop.test.ts` (record on refusal, record whatever label the
window presents, one log line per distinct refusal, and the corrected user-facing message).

No outage is required to reproduce: the owner experiment reached the same refusal through a clean
disconnect, re-authorization, and reopen.

For the repair, once the cause is known: the acceptance check is that the affected window opens the
Computers scope, and a regression pin in whichever mechanism turns out to be at fault. The
outage-driven reproduction below is retained only as the original field sequence; it is not the
minimal reproduction and should not gate the fix.

1. Connect chan-desktop to a gateway-rostered devserver and open a devserver window.
2. Restart the `devserver-proxy` serving that tenant, or otherwise break the tunnel for more than
   5s so `spawn_devserver_workspace_poll` takes its `Err` arm and calls `set_down(&id, true)`.
3. Let it recover on its own, without the disconnect overlay's Reconnect button.
4. In the recovered window, open the command deck and then Computers.

## Boundaries

The module doc's hard rules on runtime capabilities still apply: no scoped permissions and no deny
entries. Deny entries are origin-blind in tauri's `resolve_access` and would kill the command on
every origin.

## Appendix: verification commands

```sh
# gateway_csrf_token did not exist before v0.83.4
git grep -l gateway_csrf_token v0.83.3 -- desktop/ web/     # empty
git grep -l gateway_csrf_token v0.83.4 -- desktop/ web/     # 6 files

# the single mint call site
git grep -n mint_exact_origin_grant v0.84.0 -- desktop/src-tauri/src

# the capability is lib-* + one exact origin
git show v0.84.0:desktop/src-tauri/src/runtime_capability.rs | sed -n '70,135p'

# nothing gateway-side is refusing (run on the proxy node)
grep '05/Aug/2026' access.log | grep -oE '" [0-9]{3} ' | sort | uniq -c | sort -rn
```
