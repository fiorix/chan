# Gateway `lib-*` windows lose their IPC grant after a gateway outage

Status: REGISTERED for v0.84.1, filed 2026-08-05, accepted, investigation pending. The field
occurrence is the evidence; a controlled reproduction is not yet confirmed, and the root cause has
two candidate shapes that need different fixes.

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

The workaround is a full quit of chan-desktop (Cmd+Q — closing the window is not enough, the stale
authority only clears at process exit) followed by relaunch and reopening the devserver, so the
connection goes through `connect_rostered_devserver`.

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

The field trigger: a production gateway rollout (0.83.3 -> 0.84.0) replaced the `devserver-proxy`
pod. The tunnel dropped at 17:16:40 and did not re-establish until 17:19:57, a roughly three-minute
outage. The desktop rode this out as a disconnect plus automatic poll recovery, never a fresh
connect. Afterwards `gateway_csrf_token` was refused in the affected window while the connection
showed healthy in the launcher. Any gateway restart or network blip long enough to trip the poll's
`Err` arm should reproduce this.

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

The mint set is process-global and persistent, so a grant minted once should still be present after
a reconnect. Two candidate explanations are not yet distinguished, and they need different fixes,
so the investigation must settle this before implementation starts.

- (a) The process never minted for this origin at all, because the connection was established by a
  path that bypasses `connect_rostered_devserver`. Session restore at startup is the obvious
  suspect; audit what runs on launch when a gateway devserver was connected in the previous
  session.
- (b) `proxy_origin` changed across the outage, so the surviving capability covers a stale origin.
  The tenant origin embeds the user and devserver-id prefix
  (`https://<user>--<devserver_id_prefix>.<proxy_id>.usr.chan.app`) and looked stable across this
  incident, which makes (b) less likely, but it was not directly verified, and
  `exact_origin_capability_json` binds `remote.urls` to one exact origin with no fallback.

Logging the minted origin and the invoking window's origin at refusal time would settle this
immediately.

## Contract

Grant presence is an invariant of "this gateway connection is healthy", not a side effect of one
connect path. Any path that reports a gateway devserver as recovered must first ensure the IPC
grant for its current `proxy_origin` resolves.

## Implementation shape

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

Reproduction, which must exercise the automatic recovery rather than the operator-driven one:

1. Connect chan-desktop to a gateway-rostered devserver and open a devserver window. Confirm the
   Computers scope opens, so the grant is present.
2. Restart the `devserver-proxy` serving that tenant, or otherwise break the tunnel for more than
   5s so `spawn_devserver_workspace_poll` takes its `Err` arm and calls `set_down(&id, true)`.
3. Let it recover on its own. Do not use the disconnect overlay's Reconnect button; that path
   repairs the grant and masks the bug.
4. In the recovered window, open the command deck and then Computers.

Expected after the fix: the scope opens. Before the fix: "The browser blocked the new Chan window",
with `Fetch API cannot load ipc://localhost/gateway_csrf_token due to access control checks` in the
console. Step 2 is the part that was never confirmed under controlled conditions, so confirm the
exact sequence before treating the trigger as settled.

Tests:

- Unit: after `set_down(true)` then `set_down(false)` on a gateway connection, the origin's grant
  still resolves. Drive it through the existing mock-runtime `on_message` dispatch in
  `runtime_capability.rs`'s test module, which already resolves invokes against the real generated
  ACL context.
- Unit: `reconnect_devserver`'s gateway branch leaves a resolvable grant, mirroring the existing
  `reconnect_devserver_for_window` coverage.
- Regression pin: assert the recovery arms reference the ensure-grant call, in the style of the
  existing source-introspection pins around `main.rs:7588`.

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
